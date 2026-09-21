// Group voice & video calls over WebRTC — a peer-to-peer mesh. Everyone in a
// call connects directly to everyone else; the server only relays signalling
// (offer / answer / ICE) and never touches the media. Good for small groups.
import { el } from '../utils.js';
import { icon } from '../icons.js';
import { store } from '../state.js';
import { net, desktop, mediaUrl, runtime, setSetting } from '../client.js';
import { avatar } from './bits.js';
import { toast } from './toast.js';

let call = null;      // the active call, or null
let host = null;      // in-call overlay
let ringHost = null;  // incoming-ring container
let beep = null;      // WebAudio ring
let audioSink = null; // persistent, off-screen home for remote <audio> — never torn down by a re-render

function iceConfig() {
  const servers = store.server?.iceServers;
  return { iceServers: Array.isArray(servers) && servers.length ? servers : [{ urls: 'stun:stun.l.google.com:19302' }] };
}

// ------------------------------------------------------------- call sounds
function startTone(freq, every) {
  stopTone();
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    gain.connect(ctx.destination);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.connect(gain);
    osc.start();
    const pulse = () => {
      const t = ctx.currentTime;
      for (const at of [0, 0.4]) {
        gain.gain.setValueAtTime(0.0001, t + at);
        gain.gain.exponentialRampToValueAtTime(0.05, t + at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.32);
      }
    };
    pulse();
    beep = { ctx, timer: setInterval(pulse, every) };
  } catch { /* audio not available — the visual cue is enough */ }
}
function stopTone() {
  if (!beep) return;
  clearInterval(beep.timer);
  beep.ctx.close().catch(() => {});
  beep = null;
}
const startRing = () => startTone(480, 2400);
const startRingback = () => startTone(400, 3200);
const stopRing = stopTone;

// ------------------------------------------------------------- media
async function getMedia(wantVideo) {
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) {
    throw Object.assign(new Error('Calls need a secure (https) connection.'), { name: 'InsecureContext' });
  }
  const raw = await md.getUserMedia({ audio: micConstraints(), video: false });
  const stream = withInputGain(raw);
  if (!wantVideo) return stream;
  try {
    const cam = await md.getUserMedia({ audio: false, video: cameraConstraints() });
    for (const t of cam.getVideoTracks()) stream.addTrack(t);
  } catch { /* no camera — carry on audio only */ }
  return stream;
}

/**
 * Microphone level. Browsers expose no mic volume, so the captured track is
 * run through a gain node and the gained track is what gets sent. 100 = as
 * captured; below quietens, above boosts (up to 200). The raw track is kept
 * on the gained stream's owner so it can be stopped with the rest.
 */
let inputGain = null;   // GainNode for the live call, so the slider works mid-call
let inputCtx = null;
function withInputGain(raw) {
  const level = Number(store.ui.inputVolume ?? 100);
  const track = raw.getAudioTracks()[0];
  if (!track || level === 100 || !('AudioContext' in window)) { inputGain = null; return raw; }
  try {
    inputCtx = inputCtx || new AudioContext();
    const src = inputCtx.createMediaStreamSource(new MediaStream([track]));
    inputGain = inputCtx.createGain(); inputGain.gain.value = level / 100;
    const dest = inputCtx.createMediaStreamDestination();
    src.connect(inputGain); inputGain.connect(dest);
    const out = new MediaStream([dest.stream.getAudioTracks()[0], ...raw.getVideoTracks()]);
    out.__rawTracks = raw.getAudioTracks();
    // Stopping the gained track must stop the real microphone too.
    const gained = out.getAudioTracks()[0];
    const stop = gained.stop.bind(gained);
    gained.stop = () => { stop(); for (const t of raw.getAudioTracks()) t.stop(); };
    return out;
  } catch { inputGain = null; return raw; }
}
/** Live slider: adjust the gain of the call in progress. */
export function applyInputVolume() {
  const level = Number(store.ui.inputVolume ?? 100);
  if (inputGain) inputGain.gain.value = level / 100;
  else if (call?.localStream && level !== 100) void applyDeviceChange('audio'); // no gain stage yet: rebuild the mic path with one
}

/** The microphone constraints from settings: chosen device (if still present) plus processing toggles. */
export function micConstraints() {
  const c = {
    echoCancellation: store.ui.echoCancellation !== false,
    noiseSuppression: store.ui.noiseSuppression !== false,
    autoGainControl: true,
  };
  if (store.ui.micDevice) c.deviceId = { ideal: store.ui.micDevice };
  return c;
}
export function cameraConstraints() {
  const c = { width: { ideal: 1280 }, height: { ideal: 720 } };
  if (store.ui.cameraDevice) c.deviceId = { ideal: store.ui.cameraDevice };
  return c;
}

/**
 * Swap the microphone (or camera) on a live call: get the new track, hand it
 * to every peer connection with replaceTrack, and retire the old one. Called
 * from the Voice settings when the device changes; a no-op with no call.
 */
export async function applyDeviceChange(kind = 'audio') {
  if (!call?.localStream) return;
  const md = navigator.mediaDevices;
  if (kind === 'audio') {
    const fresh = withInputGain(await md.getUserMedia({ audio: micConstraints(), video: false }));
    const track = fresh.getAudioTracks()[0];
    if (!track) return;
    const old = call.localStream.getAudioTracks();
    track.enabled = old[0] ? old[0].enabled : !call.muted;
    for (const t of old) { call.localStream.removeTrack(t); t.stop(); }
    call.localStream.addTrack(track);
    for (const peer of call.peers.values()) {
      const sender = peer.pc?.getSenders?.().find((s) => s.track?.kind === 'audio' || (!s.track && s !== peer.videoSender));
      if (sender) sender.replaceTrack(track).catch(() => {});
    }
    applyPtt();
  } else if (kind === 'video' && !call.camOff && call.localStream.getVideoTracks().length) {
    const fresh = await md.getUserMedia({ audio: false, video: cameraConstraints() });
    const track = fresh.getVideoTracks()[0];
    if (!track) return;
    for (const t of call.localStream.getVideoTracks()) { call.localStream.removeTrack(t); t.stop(); }
    call.localStream.addTrack(track);
    for (const peer of call.peers.values()) if (peer.videoSender && !call.sharing) peer.videoSender.replaceTrack(track).catch(() => {});
  }
}

/** Route every remote voice to the chosen output device (headset, speakers). */
export async function applyOutputDevice() {
  if (!call) return;
  const id = store.ui.speakerDevice || '';
  for (const peer of call.peers.values()) {
    if (!peer.audioEl?.setSinkId) continue;
    try { await peer.audioEl.setSinkId(id); } catch { /* device gone or not permitted: default output */ }
  }
}

// The sender that carries our outgoing video to one peer (camera, or a slot to
// drop a screen share into). A sendrecv video transceiver on every connection
// means screen sharing never needs a renegotiation.
function videoSenderOf(pc) {
  const live = pc.getSenders().find((x) => x.track && x.track.kind === 'video');
  if (live) return live;
  const tr = pc.getTransceivers().find((t) => t.receiver?.track?.kind === 'video' || t.sender?.track?.kind === 'video');
  if (tr && tr.sender) return tr.sender;
  const created = pc.addTransceiver('video', { direction: 'sendrecv' });
  preferScreenCodecs(created);
  return created.sender;
}

// ------------------------------------------------------------- quality
// A screen share is judged by whether text is readable, so it gets the
// codec that does best on that kind of picture, a high bitrate ceiling and
// an instruction to drop frames before it drops resolution. Peer to peer,
// so the only cost is the two ends' upload and CPU.
const SCREEN_MAX_BITRATE = 10_000_000; // 10 Mb/s: 1080p60 screen content looks essentially lossless
const CAMERA_MAX_BITRATE = 2_500_000;

function preferScreenCodecs(transceiver) {
  try {
    const caps = RTCRtpSender.getCapabilities?.('video');
    if (!caps?.codecs?.length || typeof transceiver.setCodecPreferences !== 'function') return;
    const rank = (c) => (/VP9/i.test(c.mimeType) ? 0 : /H264/i.test(c.mimeType) ? 1 : /AV1/i.test(c.mimeType) ? 2 : /VP8/i.test(c.mimeType) ? 3 : 4);
    transceiver.setCodecPreferences([...caps.codecs].sort((a, b) => rank(a) - rank(b)));
  } catch { /* the browser's default order is fine */ }
}

async function tuneVideoSender(sender, { screen }) {
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.degradationPreference = screen ? 'maintain-resolution' : 'balanced';
    params.encodings[0].maxBitrate = screen ? SCREEN_MAX_BITRATE : CAMERA_MAX_BITRATE;
    params.encodings[0].maxFramerate = screen ? 60 : 30;
    delete params.encodings[0].scaleResolutionDownBy;
    await sender.setParameters(params);
  } catch { /* not negotiated yet; the connected handler tries again */ }
}

// ------------------------------------------------------------- peers (mesh)
function signal(toUserId, sig) {
  net.request('call:signal', { callId: call.callId, toUserId, signal: sig }).catch(() => {});
}

// Re-offer on an already-connected peer. Needed once, the first time a video
// sender that was negotiated with no track (see videoSenderOf()) gets a real
// one: Chromium only ever writes "send" capability into an m-line's SDP for a
// sender that *has* a track at negotiation time, so whichever side answered
// the original offer (rather than sent it) gets stuck with a receive-only
// video m-line — replaceTrack() succeeds there but nothing ever actually
// transmits. A fresh offer, now that the sender has a track, fixes it — this
// is the same offer/answer/ICE relay the initial connection already used,
// just run again on the open connection (see onSignal(), which already
// handles an offer or answer arriving at any time, not only at call setup).
function renegotiate(peer, userId) {
  peer.pc.createOffer()
    .then((o) => peer.pc.setLocalDescription(o))
    .then(() => signal(userId, { type: 'offer', sdp: peer.pc.localDescription }))
    .catch(() => {});
}

// True once this connection's video m-line can actually send — i.e. no
// renegotiation is needed before attaching a track to `sender`.
function canSendVideo(pc, sender) {
  const dir = pc.getTransceivers().find((t) => t.sender === sender)?.currentDirection;
  return dir === 'sendrecv' || dir === 'sendonly';
}

function makePeer(userId, initiator) {
  if (call.peers.has(userId)) return call.peers.get(userId);
  const pc = new RTCPeerConnection(iceConfig());
  const peer = { pc, stream: null, videoSender: null, ice: [], user: store.user(userId) };
  call.peers.set(userId, peer);

  for (const track of call.localStream.getTracks()) pc.addTrack(track, call.localStream);
  peer.videoSender = videoSenderOf(pc);
  // If we're already screen-sharing, share to the newcomer too.
  if (call.sharing && call.screenTrack) {
    peer.videoSender.replaceTrack(call.screenTrack).then(() => tuneVideoSender(peer.videoSender, { screen: true })).catch(() => {});
  }
  if (call.sharing && call.screenAudioTrack) {
    try { peer.screenAudioSender = pc.addTrack(call.screenAudioTrack, call.localStream); } catch { /* not sendable yet */ }
  }

  pc.onicecandidate = (e) => { if (e.candidate) signal(userId, { type: 'ice', candidate: e.candidate }); };
  pc.ontrack = (e) => {
    if (!peer.stream) peer.stream = new MediaStream();
    if (!peer.stream.getTracks().includes(e.track)) peer.stream.addTrack(e.track);
    if (e.track.kind === 'audio') ensureAnalyser(userId, peer.stream);
    e.track.onunmute = renderInCall;
    e.track.onmute = renderInCall;
    e.track.onended = () => { try { peer.stream.removeTrack(e.track); } catch { /* gone */ } renderInCall(); };
    syncAudio();
    renderInCall();
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      call.state = 'connected'; ensureTimer(); stopRing();
      if (call.sharing) tuneVideoSender(peer.videoSender, { screen: true });
    }
    renderInCall();
  };

  if (initiator) {
    pc.createOffer()
      .then((o) => pc.setLocalDescription(o))
      .then(() => signal(userId, { type: 'offer', sdp: pc.localDescription }))
      .catch(() => {});
  }
  return peer;
}

function closePeer(userId) {
  const peer = call.peers.get(userId);
  if (!peer) return;
  try { peer.pc.close(); } catch { /* already closed */ }
  if (peer.audioEl) { try { peer.audioEl.srcObject = null; peer.audioEl.remove(); } catch { /* gone */ } }
  call.peers.delete(userId);
  dropAnalyser(userId);
}

// ------------------------------------------------------------- lifecycle
/** Start an outgoing call to one person. `kind` is 'audio' or 'video'. */
export async function startCall(userId, kind = 'audio') {
  if (call) { toast({ title: 'Already in a call', body: 'End the current call first.', kind: 'info' }); return; }
  const partner = store.user(userId);
  if (!partner) return;
  try {
    const localStream = await getMedia(kind === 'video');
    const haveVideo = localStream.getVideoTracks().length > 0;
    const effKind = kind === 'video' && haveVideo ? 'video' : 'audio';
    if (kind === 'video' && effKind === 'audio') toast({ title: 'No camera found', body: 'Starting a voice call instead.', kind: 'info' });
    call = { callId: null, kind: effKind, state: 'calling', localStream, muted: false, camOff: false, sharing: false, peers: new Map() };
    call.cameraTrack = localStream.getVideoTracks()[0] || null;
    ensureSpeakingMeter();
    renderInCall();
    startRingback();
    const { callId } = await net.request('call:invite', { toUserId: userId, kind: effKind });
    if (!call) return;
    call.callId = callId;
    call.ringTimer = setTimeout(() => {
      if (call && call.state === 'calling' && call.peers.size === 0) { leaveCall(); toast({ title: 'No answer', kind: 'info' }); }
    }, 20000);
  } catch (err) {
    endLocal();
    console.error('[call] start failed:', err?.code, err?.name, err?.message);
    toast({ ...startFailMessage(err), kind: 'error', timeout: 8000 });
  }
}

/** Join a space's voice channel: a persistent call room shared by the channel. */
export async function startVoiceChannel(channelId, channelName) {
  let keepMuted = false;
  if (call) {
    if (call.voiceChannelId === channelId) { setCallView('full'); return; }
    if (!call.voiceChannelId) { toast({ title: 'Already in a call', body: 'End the current call first.', kind: 'info' }); return; }
    // Clicking another voice channel moves you there: leave this one and
    // join the next, keeping your mute state (a share ends with the room).
    keepMuted = Boolean(call.muted);
    leaveCall();
  }
  try {
    const localStream = await getMedia(false);
    call = {
      callId: `voice:${channelId}`, kind: 'audio', voiceChannelId: channelId, voiceChannelName: channelName,
      state: 'connecting', localStream, muted: keepMuted, camOff: false, sharing: false, peers: new Map(),
      // No `view` — a space voice channel has no floating corner widget, so
      // renderInCall() shows nothing until you deliberately open the full view.
    };
    call.cameraTrack = null;
    ensureSpeakingMeter();
    applyPtt();
    renderInCall();
    const { participants } = await net.request('voice:join', { channelId });
    if (!call) return;
    // Existing members each open a connection to us (they get 'call:peer-joined');
    // we just cache who they are and answer their offers, exactly like accepting.
    for (const p of participants || []) store.users.set(p.id, { ...(store.user(p.id) || {}), ...p });
    if (!participants || participants.length === 0) call.state = 'connected';
    renderInCall();
  } catch (err) {
    endLocal();
    toast({ ...startFailMessage(err), kind: 'error', timeout: 8000 });
  }
}

/** The voice channel this client is currently connected to, or null. */
export function currentVoiceChannel() { return call?.voiceChannelId || null; }

/** Leave a voice channel from outside the call UI — e.g. a quick disconnect
 * control right on the sidebar's connected row, with no need to open the
 * full call just to reach the "Disconnect" button. A no-op if you're
 * connected to some other channel (or nothing at all). */
export function leaveVoiceChannel(channelId) {
  if (call?.voiceChannelId === channelId) leaveCall();
}

/** An incoming ring (a new call, or being added to one). */
export function onIncoming({ callId, from, kind, participants }) {
  if (call && call.callId === callId) return;         // already in it
  if (call) { net.request('call:decline', { callId }).catch(() => {}); return; } // busy elsewhere
  for (const p of participants || []) store.users.set(p.id, { ...(store.user(p.id) || {}), ...p });
  store.users.set(from.id, { ...(store.user(from.id) || {}), ...from });
  call = { callId, kind, state: 'ringing', from, participants: participants || [], peers: new Map() };
  renderRing();
  startRing();
}

async function acceptCall() {
  if (!call || call.state !== 'ringing') return;
  stopRing(); clearRing();
  try {
    const localStream = await getMedia(call.kind === 'video');
    call.localStream = localStream;
    call.cameraTrack = localStream.getVideoTracks()[0] || null;
    call.muted = false; call.camOff = false; call.sharing = false;
    call.state = 'connecting';
    ensureSpeakingMeter();
    // Existing members will each offer to us; we just wait and answer.
    await net.request('call:accept', { callId: call.callId });
    renderInCall();
  } catch (err) {
    net.request('call:decline', { callId: call.callId }).catch(() => {});
    endLocal();
    toast({ title: 'Could not answer', body: mediaError(err), kind: 'error' });
  }
}

function declineCall() {
  if (!call) return;
  net.request('call:decline', { callId: call.callId }).catch(() => {});
  endLocal();
}

/** Someone joined the call — open a connection to them (we offer). */
export function onPeerJoined({ user }) {
  if (!call || !call.localStream) return;
  stopRing();
  if (call.state === 'calling') call.state = 'connecting';
  store.users.set(user.id, { ...(store.user(user.id) || {}), ...user });
  // Someone re-registering after a dropped socket: if our link to them died
  // in the meantime, start over with a fresh offer instead of keeping a
  // connection that will never come back.
  const existing = call.peers.get(user.id);
  if (existing && ['failed', 'disconnected', 'closed'].includes(existing.pc.connectionState)) closePeer(user.id);
  makePeer(user.id, true);
  renderInCall();
}

/**
 * The socket came back after a drop. The server forgot we were in the voice
 * channel the moment it lost us (everyone's list, our own row included,
 * updates without us), so tell it again, and repair any peer connection that
 * did not survive the gap.
 */
export async function onResumed() {
  if (!call?.voiceChannelId || !call.localStream) return;
  const channelId = call.voiceChannelId;
  try {
    const { participants } = await net.request('voice:join', { channelId });
    if (!call || call.voiceChannelId !== channelId) return;
    for (const p of participants || []) store.users.set(p.id, { ...(store.user(p.id) || {}), ...p });
    const present = new Set((participants || []).map((p) => p.id));
    for (const [uid, peer] of [...call.peers]) {
      if (!present.has(uid)) { closePeer(uid); continue; }
      if (['failed', 'disconnected', 'closed'].includes(peer.pc.connectionState)) { closePeer(uid); makePeer(uid, true); }
    }
    if (call.sharing) net.request('voice:sharing', { channelId, sharing: true }).catch(() => {});
    if (call.peers.size === 0) call.state = 'connected';
    renderInCall();
  } catch (err) {
    endLocal();
    toast({ title: 'Voice channel closed', body: err?.message || 'The connection was away too long. Join again when you are ready.', kind: 'info' });
  }
}

/** A signalling message from one peer. */
export async function onSignal({ fromUserId, signal: sig }) {
  if (!call || !call.localStream) return;
  let peer = call.peers.get(fromUserId);
  try {
    if (sig.type === 'offer') {
      if (!peer) peer = makePeer(fromUserId, false);
      await peer.pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
      for (const c of peer.ice.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      signal(fromUserId, { type: 'answer', sdp: peer.pc.localDescription });
    } else if (sig.type === 'answer' && peer) {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
      for (const c of peer.ice.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
    } else if (sig.type === 'ice' && peer) {
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(sig.candidate).catch(() => {});
      else peer.ice.push(sig.candidate);
    }
  } catch { /* a stray late signal; ignore */ }
}

export function onPeerLeft({ userId }) {
  if (!call) return;
  closePeer(userId);
  renderInCall();
}

export function onDeclined({ userId }) {
  if (!call) return;
  // A plain 1:1 ring that was turned down ends the call; in a group it's a note.
  if (call.state === 'calling' && call.peers.size === 0) {
    toast({ title: 'Call declined', body: `${store.user(userId)?.displayName || 'They'} didn’t pick up.`, kind: 'info' });
    leaveCall();
  } else {
    toast({ title: `${store.user(userId)?.displayName || 'They'} declined`, kind: 'info' });
  }
}

/** Leave / hang up. */
function leaveCall() {
  if (call?.voiceChannelId) net.request('voice:leave', { channelId: call.voiceChannelId }).catch(() => {});
  else if (call?.callId) net.request('call:leave', { callId: call.callId }).catch(() => {});
  endLocal();
}

function endLocal() {
  stopRing(); clearRing();
  if (call) {
    if (call.timer) clearInterval(call.timer);
    if (call.bwTimer) clearInterval(call.bwTimer);
    if (call.speakTimer) clearInterval(call.speakTimer);
    if (call.ringTimer) clearTimeout(call.ringTimer);
    for (const [id] of call.peers || []) closePeer(id);
    for (const t of call.localStream?.getTracks() || []) t.stop();
    if (call.screenTrack) { try { call.screenTrack.stop(); } catch { /* gone */ } }
    if (call.screenAudioTrack) { try { call.screenAudioTrack.stop(); } catch { /* gone */ } }
    dropAnalyser(store.selfId);
    if (call.audioCtx) { try { call.audioCtx.close(); } catch { /* already gone */ } call.audioCtx = null; }
  }
  call = null;
  clearInCall();
  clearAudioSink();
  syncOverlay();
  // A call ending mid-share-picker must dismiss the picker too.
  if (pickerHost) { try { window.pulse?.screen?.choose?.(null); } catch { /* no bridge */ } clearScreenPicker(); }
}

// ------------------------------------------------------------- controls
function toggleMute() {
  if (!call?.localStream) return;
  call.muted = !call.muted;
  applyPtt();
  renderInCall();
}
function toggleCam() {
  if (!call?.localStream) return;
  call.camOff = !call.camOff;
  for (const t of call.localStream.getVideoTracks()) t.enabled = !call.camOff;
  renderInCall();
}
async function toggleScreen() {
  if (!call) return;
  if (call.sharing) { stopScreen(); return; }
  try {
    const videoWanted = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60, max: 60 } };
    // Audio is asked for up front; the picker decides whether it is actually
    // included (main.js hands back a loopback track only when the person
    // ticked "share audio" and the platform can). If the engine refuses the
    // combination outright, ask again for video alone.
    let display;
    try { display = await navigator.mediaDevices.getDisplayMedia({ video: videoWanted, audio: true }); }
    catch (err) { if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') throw err; display = await navigator.mediaDevices.getDisplayMedia({ video: videoWanted, audio: false }); }
    const track = display.getVideoTracks()[0];
    if (!track) return;
    const audioTrack = display.getAudioTracks()[0] || null;
    call.screenAudioTrack = audioTrack;
    if (audioTrack) {
      audioTrack.onended = () => { if (call?.screenAudioTrack === audioTrack) dropScreenAudio(); };
      for (const [userId, peer] of call.peers) {
        try { peer.screenAudioSender = peer.pc.addTrack(audioTrack, call.localStream); } catch { continue; }
        renegotiate(peer, userId);
      }
    }
    // Sharp text over smooth motion: the encoder keeps detail and lets the
    // frame rate give first when bandwidth is short.
    try { track.contentHint = 'detail'; } catch { /* older engine */ }
    call.screenTrack = track;
    call.sharing = true;
    for (const [userId, peer] of call.peers) {
      if (!peer.videoSender) continue;
      const needsRenegotiation = !canSendVideo(peer.pc, peer.videoSender);
      peer.videoSender.replaceTrack(track).then(() => tuneVideoSender(peer.videoSender, { screen: true })).catch(() => {});
      // Order matters: attach the track first, so the fresh offer this
      // produces actually has something to declare as sendable.
      if (needsRenegotiation) renegotiate(peer, userId);
    }
    track.onended = () => stopScreen();
    if (call.voiceChannelId) net.request('voice:sharing', { channelId: call.voiceChannelId, sharing: true }).catch(() => {});
    renderInCall();
  } catch (err) {
    if (err?.name !== 'NotAllowedError' && err?.name !== 'AbortError') toast({ title: 'Could not share your screen', kind: 'error' });
  }
}
/** Stops sending the screen's audio (the share itself may continue). */
function dropScreenAudio() {
  if (!call?.screenAudioTrack) return;
  try { call.screenAudioTrack.stop(); } catch { /* gone */ }
  call.screenAudioTrack = null;
  for (const [userId, peer] of call.peers) {
    if (!peer.screenAudioSender) continue;
    try { peer.pc.removeTrack(peer.screenAudioSender); } catch { /* closed */ }
    peer.screenAudioSender = null;
    renegotiate(peer, userId);
  }
}
async function stopScreen() {
  if (!call?.sharing) return;
  try { call.screenTrack?.stop(); } catch { /* gone */ }
  dropScreenAudio();
  call.sharing = false;
  for (const peer of call.peers.values()) {
    peer.videoSender?.replaceTrack(call.cameraTrack || null).then(() => tuneVideoSender(peer.videoSender, { screen: false })).catch(() => {});
  }
  call.screenTrack = null;
  if (call.focusUid === store.selfId) call.focusUid = null;
  if (call.voiceChannelId) net.request('voice:sharing', { channelId: call.voiceChannelId, sharing: false }).catch(() => {});
  renderInCall();
}

// ------------------------------------------------------------- watching
/** Is this person's screen on the wire right now, as far as we can tell? */
function isSharingNow(uid) {
  if (!call) return false;
  if (uid === store.selfId) return Boolean(call.sharing);
  if (call.voiceChannelId && store.isSharing(call.voiceChannelId, uid)) return true;
  // Direct calls carry no server-side flag: any live remote video counts.
  return !call.voiceChannelId && hasLiveVideo(call.peers.get(uid)?.stream);
}

/** The person whose picture should fill the stage, or null for the grid. */
function focusTarget() {
  if (!call) return null;
  const liveFor = (uid) => (uid === store.selfId ? Boolean(call.sharing) : hasLiveVideo(call.peers.get(uid)?.stream));
  if (call.focusUid && liveFor(call.focusUid)) return call.focusUid;
  call.focusUid = null;
  // Nobody picked: if exactly one other person is sharing, show them.
  const sharers = [...call.peers.keys()].filter((uid) => isSharingNow(uid) && liveFor(uid));
  return sharers.length === 1 ? sharers[0] : null;
}

/**
 * Watch someone's screen share: joins the voice channel if you are not in
 * it, then opens the full call view with their picture on the stage.
 */
export async function watchStream(channelId, userId) {
  if (!call || call.voiceChannelId !== channelId) {
    const channel = store.channel(channelId);
    await startVoiceChannel(channelId, channel?.name || 'Voice');
    if (!call || call.voiceChannelId !== channelId) return;
  }
  call.focusUid = userId;
  setCallView('full');
}

/**
 * The server said who is sharing in a voice channel changed. Refresh the
 * LIVE marks, and if it is our channel, mention a newcomer and keep the
 * stage honest when the person on it stops.
 */
export function onVoiceSharing(channelId, before = [], after = []) {
  if (!call || call.voiceChannelId !== channelId) return;
  const started = after.filter((id) => !before.includes(id) && id !== store.selfId);
  const stopped = before.filter((id) => !after.includes(id));
  for (const id of started) {
    const name = store.user(id)?.displayName || 'Someone';
    toast({ title: `${name} is sharing their screen`, body: call.view === 'full' ? 'Click their tile to watch.' : 'Open the voice channel and press Watch.', kind: 'info' });
  }
  if (call.focusUid && stopped.includes(call.focusUid)) call.focusUid = null;
  renderInCall();
}

// ------------------------------------------------------------- audio
// Remote audio must NOT live inside the call overlay: renderInCall() tears the
// overlay down and rebuilds it on every track/connection event, and an <audio>
// recreated from a non-gesture event has its play() blocked by the autoplay
// policy — a connected call with no sound. So each peer keeps one persistent
// <audio> in an off-screen sink that survives every re-render.
function ensureAudioSink() {
  if (audioSink && document.body.contains(audioSink)) return audioSink;
  audioSink = el('div', { 'aria-hidden': 'true', style: 'position:absolute;width:0;height:0;overflow:hidden;' });
  document.body.appendChild(audioSink);
  return audioSink;
}

// Some environments still gate audio playback until the page has been
// interacted with. If a play() was blocked, the next click/keypress retries it.
function armAudioResume() {
  if (armAudioResume.armed) return;
  armAudioResume.armed = true;
  const resume = () => {
    for (const peer of call?.peers?.values() || []) peer.audioEl?.play?.().catch(() => {});
  };
  window.addEventListener('pointerdown', resume, true);
  window.addEventListener('keydown', resume, true);
}

// Give every current peer a live <audio>, drop ones whose peer has gone.
function syncAudio() {
  if (!call) return;
  const sink = ensureAudioSink();
  for (const [uid, peer] of call.peers) {
    if (!peer.stream || !peer.stream.getAudioTracks().length) continue;
    if (!peer.audioEl) {
      peer.audioEl = el('audio', { autoplay: '' });
      sink.appendChild(peer.audioEl);
    }
    if (peer.audioEl.srcObject !== peer.stream) peer.audioEl.srcObject = peer.stream;
    applyPeerAudio(uid);
    peer.audioEl.play?.().catch(() => { armAudioResume(); });
  }
  for (const child of [...sink.children]) {
    const stillHere = [...call.peers.values()].some((p) => p.audioEl === child);
    if (!stillHere) child.remove();
  }
}

function clearAudioSink() {
  if (audioSink) { audioSink.remove(); audioSink = null; }
}

// ------------------------------------------------------------- speaking
// A green ring around anyone (including you) whose mic is currently
// producing sound — driven by an AnalyserNode tapped off each raw audio
// track, not the <audio> elements (which only exist for remote peers and
// get torn down/rebuilt). One shared AudioContext for the whole call; every
// element tagged data-voice-uid="<id>", in the sidebar's voice-channel
// member list and the call tiles alike, lights up together.
// Detection: a fixed RMS threshold (the old way) misfired both ways — a quiet
// mic never lit up, a noisy room never went dark, and the ring flickered on
// every syllable gap. Instead each stream tracks its own noise floor in dB
// and the ring lights only on a clear, sustained rise above that floor.
const SPEAK_POLL_MS = 50;
const SPEAK_ATTACK_FRAMES = 2;   // ~100ms of sound before lighting up — clicks and pops don't count
const SPEAK_RELEASE_MS = 350;    // stays lit through a breath or a word gap, not through a real pause
const SPEAK_FLOOR_MARGIN_DB = 9; // this far above the room's noise floor reads as a voice (at the default sensitivity)
// The "input sensitivity" setting (0..100) moves that margin between 20 dB (only loud speech) and 4 dB (very sensitive).
function speakMarginDb() {
  const s = Number(store.ui.inputSensitivity);
  if (!Number.isFinite(s)) return SPEAK_FLOOR_MARGIN_DB;
  return 20 - (Math.min(100, Math.max(0, s)) / 100) * 16;
}

// ------------------------------------------------------------- push to talk
// With a key set, the microphone track is live only while the key is held.
// The key is read on the window, so it works while the app is focused.
let pttDown = false;
function pttKey() { return String(store.ui.pushToTalk || '').trim(); }
function applyPtt() {
  if (!call?.localStream) return;
  const key = pttKey();
  const open = !key || pttDown;
  for (const t of call.localStream.getAudioTracks()) t.enabled = open && !call.muted;
}
window.addEventListener('keydown', (e) => { const k = pttKey(); if (k && e.key === k && !pttDown) { pttDown = true; applyPtt(); } });
window.addEventListener('keyup', (e) => { const k = pttKey(); if (k && e.key === k) { pttDown = false; applyPtt(); } });
window.addEventListener('blur', () => { if (pttDown) { pttDown = false; applyPtt(); } });
const SPEAK_ABS_MIN_DB = -58;    // never light up on anything this quiet, whatever the floor

function ensureAnalyser(uid, stream) {
  if (!call) return;
  call.analysers ||= new Map();
  if (call.analysers.has(uid)) return;
  const track = stream?.getAudioTracks?.()[0];
  if (!track) return;
  try {
    if (!call.audioCtx) call.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // A context made outside a click starts suspended and would read silence.
    if (call.audioCtx.state === 'suspended') call.audioCtx.resume().catch(() => {});
    const source = call.audioCtx.createMediaStreamSource(new MediaStream([track]));
    const analyser = call.audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;
    source.connect(analyser);
    call.analysers.set(uid, {
      analyser, source, track, data: new Float32Array(analyser.fftSize),
      speaking: false, lastLoud: 0, loudFrames: 0, floor: null,
    });
  } catch { /* a nicety — the call still works without it */ }
}
function dropAnalyser(uid) {
  const a = call?.analysers?.get(uid);
  if (!a) return;
  try { a.source.disconnect(); } catch { /* gone */ }
  call.analysers.delete(uid);
  setSpeaking(uid, false);
}
function setSpeaking(uid, speaking) {
  for (const node of document.querySelectorAll(`[data-voice-uid="${uid}"]`)) node.classList.toggle('is-speaking', speaking);
}
/** Current loudness of one analyser, in dBFS (about -100 for silence, 0 for full scale). */
function levelDb(a) {
  a.analyser.getFloatTimeDomainData(a.data);
  let sum = 0;
  for (let i = 0; i < a.data.length; i++) sum += a.data[i] * a.data[i];
  return 20 * Math.log10(Math.max(Math.sqrt(sum / a.data.length), 1e-5));
}
function pollSpeaking() {
  if (!call?.analysers) return;
  const now = Date.now();
  for (const [uid, a] of call.analysers) {
    const isSelf = uid === store.selfId;
    // Your own ring goes dark the moment you mute; someone you've muted for
    // yourself doesn't light up either — you can't hear them, so it'd just confuse.
    const silenced = isSelf ? call.muted : peerAudioFor(uid).muted;
    const live = a.track.readyState === 'live' && !a.track.muted;
    let speaking = false;
    if (!silenced && live) {
      const db = levelDb(a);
      const loud = a.floor !== null && db > SPEAK_ABS_MIN_DB && db > a.floor + speakMarginDb();
      // The floor drops fast towards quiet and creeps up slowly, and only while
      // nobody is talking — so a long sentence can't drag it up under itself,
      // and one moment of silence brings it straight back down.
      if (a.floor === null) a.floor = db;
      else if (db < a.floor) a.floor += (db - a.floor) * 0.3;
      else if (!loud) a.floor += (db - a.floor) * 0.02;
      // Even while "loud", creep up very slowly: steady room noise that
      // started after a silent first frame must eventually become the floor,
      // while real speech keeps pulling the floor back down in its gaps.
      else a.floor += (db - a.floor) * 0.003;
      a.loudFrames = loud ? a.loudFrames + 1 : 0;
      if (a.loudFrames >= SPEAK_ATTACK_FRAMES) a.lastLoud = now;
      speaking = now - a.lastLoud < SPEAK_RELEASE_MS;
    } else {
      a.loudFrames = 0;
      a.lastLoud = 0;
    }
    if (speaking !== a.speaking) { a.speaking = speaking; setSpeaking(uid, speaking); }
  }
  syncOverlay();
}

// ------------------------------------------------------------- in-game overlay
// A corner window over the game (see main.js) showing who is in the call and
// who is talking. Shown while you are in a call and, by default, only while a
// game is running: the desktop app's own process scan and Steam both count.
let localGame = null;
/** Called by main.js when the desktop app notices a game starting or stopping. */
export function noteLocalGame(game) { localGame = game || null; syncOverlay(); }
let lastOverlayKey = '';
function overlayWanted() {
  const mode = store.ui.gameOverlay || 'game';
  if (mode === 'off' || !desktop.hasOverlay()) return false;
  if (!call || call.state === 'ringing' || !call.localStream) return false;
  if (mode === 'always') return true;
  return Boolean(localGame || store.playing(store.selfId));
}
export function syncOverlay() {
  if (!desktop.hasOverlay()) return;
  if (!overlayWanted()) {
    if (lastOverlayKey !== 'off') { lastOverlayKey = 'off'; desktop.setOverlay({ visible: false }); }
    return;
  }
  const ids = call.voiceChannelId
    ? [store.selfId, ...store.voiceUsers(call.voiceChannelId).filter((id) => id !== store.selfId)]
    : [store.selfId, ...call.peers.keys()];
  const rows = ids.map((id) => {
    const u = store.user(id) || {};
    const self = id === store.selfId;
    return {
      id, name: u.displayName || u.username || 'Someone',
      avatarUrl: mediaUrl(u.avatarUrl), color: u.avatarColor || null,
      speaking: Boolean(call.analysers?.get(id)?.speaking),
      muted: self ? Boolean(call.muted) : peerAudioFor(id).muted,
      sharing: self ? Boolean(call.sharing) : (call.voiceChannelId ? store.isSharing(call.voiceChannelId, id) : false),
    };
  });
  const state = { visible: true, corner: store.ui.overlayCorner || 'top-left', title: call.voiceChannelName || (call.kind === 'video' ? 'Video call' : 'Call'), rows };
  const key = JSON.stringify(state);
  if (key === lastOverlayKey) return;
  lastOverlayKey = key;
  desktop.setOverlay(state);
}
// Settings changes and voice-channel membership changes redraw it too.
store.on?.('ui', syncOverlay);
store.on?.('voice', syncOverlay);
store.on?.('users', syncOverlay);

// ------------------------------------------------------------- per-person audio
// "Mute for me" and a volume slider on each person in a voice channel. Purely
// local — it only changes what comes out of your speakers — and remembered
// per person across calls, since you'd otherwise redo it every time.
const PEER_AUDIO_KEY = 'voxara:peer-audio';
let peerAudio = null;
function loadPeerAudio() {
  if (peerAudio) return peerAudio;
  try { peerAudio = JSON.parse(localStorage.getItem(PEER_AUDIO_KEY) || '{}') || {}; } catch { peerAudio = {}; }
  return peerAudio;
}
/** What you've set for one person: `{ muted, volume }`, volume 0..1. */
export function peerAudioFor(uid) {
  const p = loadPeerAudio()[uid] || {};
  return { muted: Boolean(p.muted), volume: typeof p.volume === 'number' ? Math.min(1, Math.max(0, p.volume)) : 1 };
}
export function setPeerAudio(uid, patch) {
  const all = loadPeerAudio();
  const next = { ...peerAudioFor(uid), ...patch };
  if (!next.muted && next.volume === 1) delete all[uid]; else all[uid] = next;
  try { localStorage.setItem(PEER_AUDIO_KEY, JSON.stringify(all)); } catch { /* private mode — still applies for this call */ }
  applyPeerAudio(uid);
}
function applyPeerAudio(uid) {
  const peer = call?.peers.get(uid);
  if (!peer?.audioEl) return;
  const p = peerAudioFor(uid);
  peer.audioEl.muted = p.muted;
  // Per-person volume times the global output level (0..200%, capped at the element's 1.0).
  peer.audioEl.volume = Math.max(0, Math.min(1, p.volume * (Number(store.ui.outputVolume ?? 100) / 100)));
  if (store.ui.speakerDevice && peer.audioEl.setSinkId && peer.audioEl.sinkId !== store.ui.speakerDevice) {
    peer.audioEl.setSinkId(store.ui.speakerDevice).catch(() => {});
  }
}

/** Re-apply the output level to everyone (settings slider). */
export function applyOutputVolume() { if (call) for (const uid of call.peers.keys()) applyPeerAudio(uid); }

// ------------------------------------------------------------- moderation
/** A moderator disconnected you from the voice channel you were in. */
export function onVoiceKicked({ channelId }) {
  if (!call || call.voiceChannelId !== channelId) return;
  endLocal();
  toast({ title: 'Disconnected', body: 'A moderator removed you from the voice channel.', kind: 'info' });
}
/** A moderator moved you: the server has already taken you out of the old
 * room, so this is just hanging up locally and joining the new one the
 * normal way. */
export async function onVoiceMoved({ channelId, channelName }) {
  if (!call?.voiceChannelId) return;
  endLocal();
  toast({ title: `Moved to ${channelName || 'another channel'}`, kind: 'info' });
  await startVoiceChannel(channelId, channelName);
}

// ------------------------------------------------------------- bandwidth
// Total media throughput across every peer connection (audio + video +
// screen share summed), sampled every 2s from getStats() and turned into a
// rate by diffing against the previous sample. Updated in place via
// getElementById, like the timer — never through a full re-render, which
// would tear down and restart the live media elements.
function formatRate(bytesPerSec) {
  const bits = Math.max(0, bytesPerSec) * 8;
  if (bits < 1000) return `${Math.round(bits)} b/s`;
  if (bits < 1_000_000) return `${(bits / 1000).toFixed(bits < 10_000 ? 1 : 0)} kb/s`;
  return `${(bits / 1_000_000).toFixed(1)} Mb/s`;
}
async function pollBandwidth() {
  if (!call || !call.peers.size) return;
  let bytesSent = 0, bytesReceived = 0;
  for (const peer of call.peers.values()) {
    try {
      const stats = await peer.pc.getStats();
      stats.forEach((r) => {
        if (r.type === 'outbound-rtp') bytesSent += r.bytesSent || 0;
        else if (r.type === 'inbound-rtp') bytesReceived += r.bytesReceived || 0;
      });
    } catch { /* connection gone mid-read */ }
  }
  const now = Date.now();
  if (call && call.bwLast) {
    const dt = (now - call.bwLast.time) / 1000;
    if (dt > 0) {
      call.bw = {
        up: (bytesSent - call.bwLast.bytesSent) / dt,
        down: (bytesReceived - call.bwLast.bytesReceived) / dt,
      };
      const label = document.getElementById('callBandwidth');
      if (label) label.textContent = `↑ ${formatRate(call.bw.up)}  ↓ ${formatRate(call.bw.down)}`;
    }
  }
  if (call) call.bwLast = { time: now, bytesSent, bytesReceived };
}

// ------------------------------------------------------------- rendering
function ensureTimer() {
  if (call.timer) return;
  call.startedAt = Date.now();
  call.timer = setInterval(() => { const l = document.getElementById('callTimer'); if (l) l.textContent = elapsed(); }, 1000);
  call.bw = { up: 0, down: 0 };
  call.bwLast = null;
  call.bwTimer = setInterval(pollBandwidth, 2000);
  pollBandwidth();
  ensureSpeakingMeter();
}

/**
 * Your own speaking ring must not wait for anyone's connection: it starts
 * the moment your microphone is open, whether the channel is empty, the
 * peers are still negotiating, or a call is still ringing out.
 */
function ensureSpeakingMeter() {
  if (!call?.localStream) return;
  ensureAnalyser(store.selfId, call.localStream);
  if (!call.speakTimer) call.speakTimer = setInterval(pollSpeaking, SPEAK_POLL_MS);
}
function elapsed() {
  const s = Math.floor((Date.now() - (call.startedAt || Date.now())) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function stateLabel() {
  if (call.state === 'calling') return 'Calling…';
  if (call.state === 'connecting') return 'Connecting…';
  if (call.state === 'connected') return elapsed();
  return '';
}
function hasLiveVideo(stream) {
  return Boolean(stream && stream.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted));
}

function renderRing() {
  clearRing();
  const others = (call.participants || []).filter((p) => p.id !== call.from.id).length;
  const sub = others > 0
    ? `Adding you to a call with ${call.from.displayName} and ${others} other${others === 1 ? '' : 's'}`
    : `Incoming ${call.kind === 'video' ? 'video' : 'voice'} call`;
  ringHost = el('div', { class: 'callring', role: 'dialog', 'aria-label': 'Incoming call' },
    avatar(call.from, { size: 'md' }),
    el('div', { class: 'callring__text' },
      el('div', { class: 'callring__name' }, call.from.displayName),
      el('div', { class: 'callring__sub' }, sub)),
    el('div', { class: 'callring__btns' },
      iconBtn('phone', 'Decline', 'callbtn--decline', declineCall),
      iconBtn(call.kind === 'video' ? 'video' : 'phone', 'Accept', 'callbtn--accept', acceptCall)));
  document.body.appendChild(ringHost);
}
function clearRing() { if (ringHost) { ringHost.remove(); ringHost = null; } }

function selfUser() { return store.user(store.selfId) || { displayName: 'You' }; }

function tile(user, stream, { self = false, id } = {}) {
  const video = hasLiveVideo(stream);
  const live = id ? isSharingNow(id) : false;
  const focused = id && call.focusUid === id;
  const node = el('div', {
    class: `calltile${video ? ' calltile--video' : ''}${video ? ' calltile--focusable' : ''}${focused ? ' is-focused' : ''}`,
    dataset: id ? { voiceUid: id } : {},
    ...(video && id ? { title: focused ? 'Back to the grid' : 'Watch full size', onClick: () => { call.focusUid = focused ? null : id; renderInCall(); } } : {}),
  });
  if (live) node.appendChild(el('span', { class: 'calltile__live' }, icon('screen-share'), 'LIVE'));
  if (video && id && !focused) node.appendChild(el('span', { class: 'calltile__watch' }, 'Watch'));
  if (video) {
    node.appendChild(videoEl(stream, self && !call.sharing, 'calltile__video'));
  } else {
    node.appendChild(el('div', { class: 'calltile__face' }, avatar(user, { size: 'lg' })));
  }
  // Remote audio is played from the persistent sink (syncAudio), not from this
  // tile — the tile is rebuilt constantly and would restart/kill playback.
  node.appendChild(el('div', { class: 'calltile__name' },
    self ? 'You' : (user.displayName || 'Guest'),
    self && call.muted ? el('span', { class: 'calltile__mic' }, icon('mic-off')) : null));
  return node;
}

// Which way the in-call UI is shown: 'full' takes over the screen, 'mini' is a
// floating card in the corner you can use the app behind, 'hidden' is a tiny
// pill so it's out of the way entirely (you're still in the call).
function setCallView(v) {
  if (!call) return;
  call.view = v;
  renderInCall();
}

/** A short title for the call — the voice channel's name, or who you're with. */
function callTitle() {
  if (call.voiceChannelName) return call.voiceChannelName;
  if (call.peers.size === 1) return [...call.peers.values()][0].user?.displayName || store.user([...call.peers.keys()][0])?.displayName || 'In call';
  if (call.peers.size > 1) return `${call.peers.size + 1} in call`;
  return call.state === 'calling' ? 'Calling…' : 'Voice';
}

/** Toggle the view on a double-click anywhere except a button. */
function onDblclickToggle(toView) {
  return (event) => { if (!event.target.closest('button')) setCallView(toView); };
}

function renderInCall() {
  if (!call || call.state === 'ringing') return;
  clearInCall();
  // A space voice channel has no floating corner widget — it's either the
  // full call, deliberately opened, or nothing at all; the sidebar's
  // connected row (and its speaking indicators) is the ambient cue the rest
  // of the time. Only a direct call gets the mini card / tucked-away pill.
  if (call.voiceChannelId) {
    // No widget, but the timers (and with them the speaking meter on your
    // own mic) must still run — alone in a channel you are "connected" the
    // moment you join, with nobody's connection event to start them later.
    if (call.view !== 'full') { syncAudio(); if (call.state === 'connected') ensureTimer(); return; }
    host = buildFull();
  } else {
    const view = call.view || 'full';
    call.view = view;
    if (view === 'hidden') host = buildHiddenPill();
    else if (view === 'mini') host = buildMini();
    else host = buildFull();
  }
  document.body.appendChild(host);
  syncAudio();
  if (call.state === 'connected') ensureTimer();
}

function buildFull() {
  const node = el('div', {
    class: 'call', role: 'dialog', 'aria-label': 'Call',
    onDblclick: (event) => { if (!event.target.closest('button')) setCallView(call.voiceChannelId ? null : 'mini'); },
  });

  const focusId = focusTarget();
  if (focusId && !call.focusUid) call.focusUid = focusId;
  const tiles = [tile(selfUser(), call.sharing && call.screenTrack ? new MediaStream([call.screenTrack]) : call.localStream, { self: true, id: store.selfId })];
  for (const [uid, peer] of call.peers) tiles.push(tile(store.user(uid) || peer.user || { displayName: 'Guest' }, peer.stream, { id: uid }));
  let grid;
  if (focusId) {
    // One picture on the stage (someone's screen), everyone else in a strip.
    const main = tiles.find((t) => t.dataset.voiceUid === focusId);
    const rest = tiles.filter((t) => t !== main);
    grid = el('div', { class: 'call__stage' },
      el('div', { class: 'call__stage-main' }, main),
      rest.length ? el('div', { class: 'call__strip' }, rest) : null);
  } else {
    grid = el('div', { class: `call__grid call__grid--n${Math.min(tiles.length, 6)}` }, tiles);
  }

  const header = el('div', { class: 'call__header' },
    iconBtn('chevron-down', call.voiceChannelId ? 'Close' : 'Minimize', 'callbtn--ghost',
      () => setCallView(call.voiceChannelId ? null : 'mini')));

  const bar = el('div', { class: 'call__bar' },
    el('div', { class: 'call__who' },
      el('div', { class: 'call__name' }, call.peers.size ? `${call.peers.size + 1} in call` : (call.state === 'calling' ? 'Calling…' : 'Waiting…')),
      el('div', { class: 'call__state', id: 'callTimer' }, stateLabel()),
      call.state === 'connected' ? el('div', { class: 'callbw', id: 'callBandwidth' }, '↑ 0 b/s  ↓ 0 b/s') : null),
    el('div', { class: 'call__controls' },
      iconBtn('plus', 'Add people', '', () => openAddPeople()),
      iconBtn(call.muted ? 'mic-off' : 'mic', call.muted ? 'Unmute' : 'Mute', call.muted ? 'callbtn--off' : '', toggleMute),
      call.kind === 'video' ? iconBtn(call.camOff ? 'video-off' : 'video', call.camOff ? 'Camera on' : 'Camera off', call.camOff ? 'callbtn--off' : '', toggleCam) : null,
      iconBtn('screen-share', call.sharing ? 'Stop sharing' : 'Share screen', call.sharing ? 'callbtn--on' : '', toggleScreen),
      iconBtn('phone', call.voiceChannelId ? 'Disconnect' : 'Leave', 'callbtn--decline', leaveCall)));

  node.append(header, grid, bar);
  if (call.sharing) node.appendChild(el('div', { class: 'call__sharing' }, 'You’re sharing your screen'));
  return node;
}

function buildMini() {
  const faces = el('div', { class: 'callmini__faces' });
  faces.appendChild(avatar(selfUser(), { size: 'sm' }));
  for (const [uid, peer] of call.peers) faces.appendChild(avatar(store.user(uid) || peer.user || { displayName: 'Guest' }, { size: 'sm' }));

  const node = el('div', {
    class: 'callmini', role: 'dialog', 'aria-label': 'Call',
    onDblclick: onDblclickToggle('full'),
  },
    el('div', { class: 'callmini__top' },
      el('div', { class: 'callmini__meta' },
        el('div', { class: 'callmini__name' },
          call.voiceChannelId ? icon('speaker') : icon('phone'), callTitle()),
        el('div', { class: 'callmini__state', id: 'callTimer' }, stateLabel()),
        call.state === 'connected' ? el('div', { class: 'callbw', id: 'callBandwidth' }, '↑ 0 b/s  ↓ 0 b/s') : null),
      el('div', { class: 'callmini__winbtns' },
        iconBtn('expand', 'Expand', 'callbtn--ghost callbtn--tiny', () => setCallView('full')),
        iconBtn('close', 'Hide', 'callbtn--ghost callbtn--tiny', () => setCallView('hidden')))),
    faces,
    [...call.peers].some(([, peer]) => hasLiveVideo(peer.stream))
      ? el('button', { class: 'callmini__watch', type: 'button', onClick: () => { call.focusUid = [...call.peers].find(([, p]) => hasLiveVideo(p.stream))?.[0] || null; setCallView('full'); } }, icon('screen-share'), 'Watch their screen')
      : null,
    el('div', { class: 'callmini__controls' },
      iconBtn(call.muted ? 'mic-off' : 'mic', call.muted ? 'Unmute' : 'Mute', call.muted ? 'callbtn--off' : '', toggleMute),
      call.kind === 'video' ? iconBtn(call.camOff ? 'video-off' : 'video', call.camOff ? 'Camera on' : 'Camera off', call.camOff ? 'callbtn--off' : '', toggleCam) : null,
      iconBtn('screen-share', call.sharing ? 'Stop sharing' : 'Share screen', call.sharing ? 'callbtn--on' : '', toggleScreen),
      iconBtn('phone', call.voiceChannelId ? 'Disconnect' : 'Leave', 'callbtn--decline', leaveCall)));
  return node;
}

function buildHiddenPill() {
  const node = el('button', {
    class: 'callpill', type: 'button', title: 'Show call',
    onClick: () => setCallView('mini'),
  },
    call.voiceChannelId ? icon('speaker') : icon('phone'),
    el('span', { class: 'callpill__time', id: 'callTimer' }, stateLabel()));
  return node;
}

function clearInCall() { if (host) { host.remove(); host = null; } }

// ------------------------------------------------------------- add people
function openAddPeople() {
  document.getElementById('addPeople')?.remove();
  const inCallIds = new Set([store.selfId, ...call.peers.keys()]);
  const friends = [...store.friends]
    .map((id) => store.user(id))
    .filter((u) => u && !inCallIds.has(u.id) && u.status && u.status !== 'offline');

  const rows = friends.length
    ? friends.map((u) => el('button', {
      class: 'addpeople__row', type: 'button',
      onClick: async () => {
        try { await net.request('call:add', { callId: call.callId, toUserId: u.id }); toast({ title: `Ringing ${u.displayName}…`, kind: 'info' }); panel.remove(); }
        catch (err) { toast({ title: err.message, kind: 'error' }); }
      },
    }, avatar(u, { size: 'sm' }), el('span', {}, u.displayName)))
    : [el('p', { class: 'addpeople__empty' }, 'No online friends to add right now.')];

  const panel = el('div', { class: 'addpeople', role: 'dialog', 'aria-label': 'Add people to the call' },
    el('div', { class: 'addpeople__head' }, 'Add to call',
      el('button', { class: 'addpeople__x', type: 'button', 'aria-label': 'Close', onClick: () => panel.remove() }, '×')),
    el('div', { class: 'addpeople__list' }, rows));
  panel.id = 'addPeople';
  host.appendChild(panel);
}

// ------------------------------------------------------------- helpers
function videoEl(stream, mirror, cls) {
  const v = el('video', { class: cls, autoplay: '', playsinline: '', draggable: 'false', ...(mirror ? { muted: '' } : {}) });
  if (mirror) v.muted = true;
  v.srcObject = stream;
  v.play?.().catch(() => {});
  return v;
}
function iconBtn(name, label, cls, onClick) {
  return el('button', { class: `callbtn ${cls || ''}`, type: 'button', title: label, 'aria-label': label, onClick }, icon(name));
}
function mediaError(err) {
  switch (err?.name) {
    case 'NotAllowedError': return 'Microphone access was blocked. Allow it for Voxara in your system settings, then try again.';
    case 'NotFoundError': return 'No microphone was found. Plug one in and try again.';
    case 'NotReadableError': return 'Your microphone is in use by another app. Close it and try again.';
    case 'InsecureContext': return 'Calls need a secure (https) connection.';
    default: return 'Could not access your microphone. Check it and try again.';
  }
}
const MEDIA_ERRORS = new Set(['NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError', 'SecurityError', 'InsecureContext', 'AbortError', 'TypeError']);
function startFailMessage(err) {
  if (err?.code === 'offline') return { title: 'Couldn’t place the call', body: 'You’re not connected to the server.' };
  if (err?.code === 'forbidden') return { title: 'Can’t call them', body: 'You can only call friends or people you share a space with.' };
  if (MEDIA_ERRORS.has(err?.name)) return { title: 'Could not start the call', body: `${mediaError(err)} [${err?.name || 'unknown'}]` };
  return { title: 'Could not start the call', body: err?.message || 'Please try again.' };
}

/** True if a call is currently active (any state). */
export function inCall() { return Boolean(call); }

// ---------------------------------------------------- screen-source picker
// Desktop app only: the main process hands us the source list; we show a live
// preview of the selected source and share once it's confirmed. On the web the
// browser shows its own picker and none of this runs.
let pickerHost = null;
let previewStream = null;
let previewTimer = null;

function stopPreview() {
  for (const t of previewStream?.getTracks() || []) t.stop();
  previewStream = null;
  if (previewTimer) { clearInterval(previewTimer); previewTimer = null; }
}

// A light refreshing snapshot — used only when a live stream isn't available,
// so the preview still moves instead of being a dead still.
function startThumbRefresh(src, paneNode) {
  const refresh = async () => {
    try {
      const shot = await window.pulse?.screen?.preview?.(src.id);
      if (shot && pickerHost && paneNode.isConnected) paneNode.style.backgroundImage = `url("${shot}")`;
    } catch { /* keep the last frame */ }
  };
  refresh();
  previewTimer = setInterval(refresh, 1000);
}

// Prefer a smooth live desktop-capture stream (no polling). If it doesn't
// produce frames, fall back to the refreshing snapshot above.
async function startPreview(src, videoNode, paneNode) {
  stopPreview();
  paneNode.style.backgroundImage = `url("${src.thumb}")`;
  videoNode.hidden = true;
  try {
    previewStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: src.id, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 15 } },
    });
    videoNode.srcObject = previewStream;
    videoNode.hidden = false;
    videoNode.play?.().catch(() => {});
    paneNode.style.backgroundImage = '';
  } catch { /* fall through to the snapshot refresh */ }
  // Give the live stream a moment; if it never renders a frame, keep it moving
  // with snapshots instead of a frozen thumbnail.
  setTimeout(() => {
    if (!pickerHost || previewTimer) return;
    if (previewStream && videoNode.videoWidth > 0) return;
    videoNode.hidden = true;
    stopPreview();
    startThumbRefresh(src, paneNode);
  }, 1100);
}

function showScreenPicker(sources) {
  clearScreenPicker();
  let selectedId = null;

  const audioBox = el('input', { type: 'checkbox', id: 'screenAudio' });
  const canLoopback = runtime.platform === 'win32';
  audioBox.checked = canLoopback && store.ui.shareAudio !== false;
  audioBox.disabled = !canLoopback;
  const finish = (id) => {
    stopPreview();
    if (id) { store.ui.shareAudio = audioBox.checked; setSetting('shareAudio', audioBox.checked); }
    try { window.pulse.screen.choose(id, { audio: audioBox.checked }); } catch { /* no bridge */ }
    clearScreenPicker();
  };

  const previewVideo = el('video', { class: 'screenpick__video', autoplay: '', muted: '', playsinline: '' });
  previewVideo.muted = true;
  const previewPane = el('div', { class: 'screenpick__pane' });
  const previewName = el('div', { class: 'screenpick__pname' }, 'Choose what to share');
  const shareBtn = el('button', { class: 'btn btn--primary', type: 'button', disabled: '' }, 'Share');
  shareBtn.addEventListener('click', () => { if (selectedId) finish(selectedId); });

  const tiles = new Map();
  const select = (src) => {
    selectedId = src.id;
    shareBtn.disabled = false;
    previewName.textContent = src.name;
    for (const [id, tileEl] of tiles) tileEl.classList.toggle('is-selected', id === src.id);
    startPreview(src, previewVideo, previewPane);
  };

  const tileFor = (src) => {
    const node = el('button', { class: 'screenpick__tile', type: 'button', onClick: () => select(src) },
      el('div', { class: 'screenpick__thumb', style: `background-image:url("${src.thumb}")` }),
      el('div', { class: 'screenpick__name' }, src.name));
    node.addEventListener('dblclick', () => finish(src.id));
    tiles.set(src.id, node);
    return node;
  };
  // Tiles keep up with what each window shows now, not what it showed when
  // the picker opened: a fresh set of thumbnails every couple of seconds.
  const tileTimer = setInterval(async () => {
    if (!pickerHost) { clearInterval(tileTimer); return; }
    let fresh = [];
    try { fresh = await window.pulse?.screen?.thumbs?.() || []; } catch { fresh = []; }
    for (const { id, thumb } of fresh) {
      const t = tiles.get(id)?.querySelector('.screenpick__thumb');
      if (t && thumb) t.style.backgroundImage = `url("${thumb}")`;
    }
  }, 2000);

  const screens = sources.filter((x) => x.kind === 'screen');
  const windows = sources.filter((x) => x.kind === 'window');

  pickerHost = el('div', { class: 'screenpick', role: 'dialog', 'aria-label': 'Choose what to share' },
    el('div', { class: 'screenpick__card' },
      el('h2', {}, 'Share your screen'),
      el('div', { class: 'screenpick__preview' }, previewPane, previewVideo, previewName),
      el('div', { class: 'screenpick__lists' },
        screens.length ? el('div', { class: 'screenpick__label' }, screens.length > 1 ? 'Screens' : 'Screen') : null,
        screens.length ? el('div', { class: 'screenpick__grid' }, screens.map(tileFor)) : null,
        windows.length ? el('div', { class: 'screenpick__label' }, 'Windows') : null,
        windows.length ? el('div', { class: 'screenpick__grid' }, windows.map(tileFor)) : null),
      el('div', { class: 'screenpick__foot' },
        el('label', { class: 'screenpick__audio', for: 'screenAudio', title: canLoopback ? '' : 'Sharing what your computer plays is available on Windows.' },
          audioBox, el('span', {}, canLoopback ? 'Share audio (what your computer plays)' : 'Share audio: Windows only')),
        el('div', { class: 'screenpick__btns' },
          el('button', { class: 'btn btn--sm', type: 'button', onClick: () => finish(null) }, 'Cancel'),
          shareBtn))));

  pickerHost.addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(null); });
  document.body.appendChild(pickerHost);
  if (screens.length) select(screens[0]);
  else if (windows.length) select(windows[0]);
  shareBtn.focus();
}
function clearScreenPicker() { stopPreview(); if (pickerHost) { pickerHost.remove(); pickerHost = null; } }

try { window.pulse?.screen?.onRequest?.(showScreenPicker); } catch { /* web build */ }

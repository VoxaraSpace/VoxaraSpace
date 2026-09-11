'use strict';

/**
 * Writes real version metadata into Voxara.exe.
 *
 * electron-builder normally does this with rcedit, which is a Windows binary
 * and needs Wine to run on Linux. This box has no Wine, so `signAndEditExecutable`
 * is off and the packaged exe would otherwise keep Electron's stock resources —
 * including "Copyright (C) 2015 GitHub, Inc." and a placeholder product name.
 *
 * resedit is pure JavaScript, so it patches the PE resource table anywhere.
 * Correct metadata does not stop SmartScreen (only an Authenticode signature
 * does that) but it stops the app from misrepresenting itself, and heuristic
 * AV engines treat a binary with blank or contradictory version info as more
 * suspicious than one that names itself honestly.
 */

const fs = require('node:fs');
const path = require('node:path');
const { markIconPng } = require('../icon-art');

const PRODUCT = 'Voxara';
const COMPANY = 'Voxara';
const DESCRIPTION = 'Voxara — voice and text chat';
// Vista+ ICO entries can embed PNG data directly at any size (not just the
// classic 256 exception) — this app targets Windows only, so no need to
// also hand-build the older BMP/DIB icon format.
const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** "1.2.1" -> [1, 2, 1, 0], which is the fixed 4-part shape PE expects. */
function versionParts(version) {
  const nums = String(version).split('.').map((n) => parseInt(n, 10) || 0);
  while (nums.length < 4) nums.push(0);
  return nums.slice(0, 4);
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  if (!fs.existsSync(exePath)) {
    console.warn(`  afterPack: no exe at ${exePath}, skipping metadata`);
    return;
  }

  // resedit v2 ships as ESM only, so it has to be pulled in dynamically from
  // this CommonJS hook.
  const ResEdit = await import('resedit');
  const version = context.packager.appInfo.version;

  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);

  const versions = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (!versions.length) {
    console.warn('  afterPack: no version resource found, skipping metadata');
    return;
  }
  const info = versions[0];

  const parts = versionParts(version);
  info.setFileVersion(...parts);
  info.setProductVersion(...parts);

  // Replace every language block the binary carries, so no stale English
  // resource survives under a different lang id.
  for (const lang of info.getAllLanguagesForStringValues()) {
    info.setStringValues(lang, {
      ProductName: PRODUCT,
      FileDescription: DESCRIPTION,
      CompanyName: COMPANY,
      LegalCopyright: `Copyright (C) ${new Date().getFullYear()} ${COMPANY}`,
      OriginalFilename: `${PRODUCT}.exe`,
      InternalName: PRODUCT,
      FileVersion: version,
      ProductVersion: version,
    });
  }

  info.outputToResourceEntries(res.entries);

  // Replace the app icon with the real Voxara mark. Electron's stock icon
  // group already exists in the binary under some id/lang — reuse those
  // rather than guessing, so this doesn't silently no-op on a future
  // Electron version that numbers its icon resource differently.
  const existingGroups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  if (existingGroups.length) {
    const iconGroupID = existingGroups[0].id;
    const iconLang = existingGroups[0].lang;
    const icons = ICON_SIZES.map((size) => ResEdit.Data.RawIconItem.from(markIconPng(size), size, size, 32));
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, iconGroupID, iconLang, icons);
  } else {
    console.warn('  afterPack: no icon-group resource found, leaving Electron\'s stock icon');
  }

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));

  console.log(`  afterPack: stamped ${PRODUCT} ${version} and the app icon into ${path.basename(exePath)}`);
};

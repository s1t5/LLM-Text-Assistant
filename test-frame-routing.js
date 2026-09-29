// Verifies the iframe/all_frames support (Teams & embedded editors):
//   1. Manifests inject the content script into ALL frames
//      (all_frames + match_about_blank) — without it, editors living in
//      iframes (Teams compose box) never see the content script at all,
//      which is why Teams never worked.
//   2. background.js routes context-menu actions to the CLICKED frame
//      (info.frameId): selection capture, the contextMenuProcess message,
//      the non-streaming replacement and error toast, and the
//      injectReplacement fallback.
//      Without frame targeting, the top frame's content script would
//      swallow the action while the focused editor sits in a child frame.
// Structural checks (regex/index based) — same style as the S/V groups in
// test-free-prompt-route.js.

const fs = require('fs');

const bg = fs.readFileSync(__dirname + '/background.js', 'utf8');
const rootManifest = JSON.parse(fs.readFileSync(__dirname + '/manifest.json', 'utf8'));
const ffManifest = JSON.parse(fs.readFileSync(__dirname + '/platform/firefox/manifest.json', 'utf8'));

let fails = 0;
const check = (label, ok, detail) => {
  if (!ok) fails++;
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + label + (detail ? ' — ' + detail : ''));
};

// --- 1) manifests: all_frames ----------------------------------------------
const csOk = (m) => m.content_scripts && m.content_scripts.length > 0 &&
  m.content_scripts.every((cs) => cs.all_frames === true && cs.match_about_blank === true);
check('M1: root manifest injects into all frames', csOk(rootManifest));
check('M2: firefox overlay injects into all frames', csOk(ffManifest));

// --- 2) background.js frame routing ----------------------------------------
// Selection capture must target the clicked frame.
const captureIdx = bg.indexOf('chrome.scripting.executeScript({');
const captureTargetIdx = bg.indexOf('target: { tabId: tab.id, frameIds: [info.frameId] }', captureIdx);
check('F1: selection capture targets info.frameId',
  captureTargetIdx > captureIdx && captureTargetIdx !== -1);

// The contextMenuProcess message must carry the frameId option.
const ctxSendIdx = bg.indexOf('action: "contextMenuProcess"');
const frameOptIdx = bg.indexOf('{ frameId: info.frameId }', ctxSendIdx);
check('F2: contextMenuProcess message goes to the clicked frame',
  frameOptIdx > ctxSendIdx && frameOptIdx !== -1 &&
  frameOptIdx < ctxSendIdx + 400,
  'frameOpt@' + frameOptIdx + ' ctxSend@' + ctxSendIdx);

// processTextNonStreaming signature takes a frameId parameter.
check('F3: processTextNonStreaming accepts frameId',
  /async function processTextNonStreaming\(action, text, tab, isFullText = false, frameId\)/.test(bg));

// Callers pass sender.frameId through.
check('F4: processFullText passes sender.frameId',
  /processTextNonStreaming\(request.textAction, request.text, sender.tab, true, sender.frameId\)/.test(bg));
check('F5: processSelection passes sender.frameId',
  /processTextNonStreaming\(request.textAction, request.text, sender.tab, false, sender.frameId\)/.test(bg));

// The result message routes back into the requesting frame.
const replaceSendIdx = bg.indexOf('action: messageAction');
const replaceFrameIdx = bg.indexOf('const sendOpts = (frameId !== undefined) ? { frameId } : undefined;', replaceSendIdx - 500);
check('F6: replacement result routed back to the requesting frame',
  replaceFrameIdx !== -1 && replaceFrameIdx < replaceSendIdx);

// Error toast routed to the requesting frame.
check('F7: error toast routed to the requesting frame',
  /const errSendOpts = \(frameId !== undefined\) \? \{ frameId \} : undefined;/.test(bg));

// injectReplacement targets the frame.
check('F8: injectReplacement targets frameId',
  /if \(frameId !== undefined\) target.frameIds = \[frameId\];/.test(bg));

console.log(fails === 0 ? '\nALL TESTS PASSED' : '\n' + fails + ' FAILURES');
process.exit(fails ? 1 : 0);
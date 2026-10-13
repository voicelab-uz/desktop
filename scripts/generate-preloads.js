const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const templatePath = path.join(root, "preload.js");
const outputDir = path.join(root, "preloads");
const source = fs.readFileSync(templatePath, "utf8");
const allNames = [...source.matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1]);

const windowSpecific = new Set([
  "onMeetingNotificationData",
  "getMeetingNotificationData",
  "meetingNotificationReady",
  "meetingNotificationRespond",
  "joinCalendarMeeting",
  "onPreviewText",
  "onPreviewAppend",
  "onPreviewHold",
  "onPreviewResult",
  "onPreviewHide",
  "resizeTranscriptionPreviewWindow",
  "accessibilityDropStartDrag",
]);

const controlOnly = new Set([
  "clearTranscriptions",
  "deleteTranscription",
  "deleteTranscriptionAudio",
  "setDictionary",
  "createDictionaryEntry",
  "updateDictionaryEntry",
  "deleteDictionaryEntry",
  "decideLegacyDictionary",
  "saveNote",
  "updateNote",
  "deleteNote",
  "semanticReindexAll",
  "updateNoteCloudId",
  "createFolder",
  "deleteFolder",
  "renameFolder",
  "createAction",
  "updateAction",
  "deleteAction",
  "deleteAllAudio",
  "cleanupApp",
  "noteFilesSetEnabled",
  "noteFilesSetPath",
  "noteFilesRebuild",
  "noteFilesPickFolder",
  "downloadDiarizationModels",
  "deleteDiarizationModels",
  "llamaCppInstall",
  "llamaCppUninstall",
  "downloadLlamaVulkanBinary",
  "deleteLlamaVulkanBinary",
  "modelDownload",
  "modelCancelDownload",
  "modelDelete",
  "modelDeleteAll",
  "setAutoStartEnabled",
  "gcalStartOAuth",
  "gcalDisconnect",
  "gcalGetConnectionStatus",
  "gcalGetCalendars",
  "gcalSetCalendarSelection",
  "gcalSetPrimaryOnly",
  "gcalSyncEvents",
  "gcalGetUpcomingEvents",
  "gcalGetEvent",
  "checkForUpdates",
  "downloadUpdate",
  "installUpdate",
  "getUpdateStatus",
  "getUpdateInfo",
  "workspaceApiRequest",
  "armDisplayMediaCapture",
  "providerSaveCredential",
  "providerSaveEndpoint",
  "providerListModels",
  "providerTranscribeFile",
  "getTinfoilChatModels",
  "getBedrockRegion",
  "saveBedrockRegion",
  "getBedrockProfile",
  "saveBedrockProfile",
  "getAzureEndpoint",
  "saveAzureEndpoint",
  "getAzureDeployment",
  "saveAzureDeployment",
  "getAzureApiVersion",
  "saveAzureApiVersion",
  "getVertexProject",
  "saveVertexProject",
  "getVertexLocation",
  "saveVertexLocation",
  "authStartBrowser",
  "authGetProfile",
  "desktopOnboardingGet",
  "desktopOnboardingSave",
  "authRefreshSession",
  "authLogout",
  "authDeleteAccount",
  "desktopPricing",
  "desktopSubscription",
  "onDictationComplete",
  "desktopListTranscriptions",
  "desktopGetTranscription",
  "desktopUpdateTranscription",
]);

const agent = new Set([
  "getPlatform",
  "hideAgentOverlay",
  "resizeAgentWindow",
  "getAgentWindowBounds",
  "setAgentWindowBounds",
  "onAgentStartRecording",
  "onAgentStopRecording",
  "onAgentToggleRecording",
  "acquireRecordingLock",
  "releaseRecordingLock",
  "startAgentStream",
  "onAgentStreamChunk",
  "onAgentStreamError",
  "onAgentStreamEnd",
  "agentWebSearch",
  "agentOpenNote",
  "createAgentConversation",
  "getAgentConversations",
  "getAgentConversation",
  "deleteAgentConversation",
  "updateAgentConversationTitle",
  "addAgentMessage",
  "getAgentMessages",
  "getAgentConversationsWithPreview",
  "searchAgentConversations",
  "getConversationsForNote",
  "archiveAgentConversation",
  "unarchiveAgentConversation",
  "updateAgentConversationCloudId",
  "semanticSearchConversations",
  "searchNotes",
  "semanticSearchNotes",
  "getNote",
  "writeClipboard",
  "providerCredentialStatus",
  "providerReason",
  "providerStreamStart",
  "providerStreamCancel",
  "onProviderStreamPart",
  "processLocalReasoning",
  "checkLocalReasoningAvailable",
  "llamaServerStart",
]);

const notification = new Set([
  "getPlatform",
  "setNotificationInteractivity",
  "onMeetingNotificationData",
  "getMeetingNotificationData",
  "meetingNotificationReady",
  "meetingNotificationRespond",
  "joinCalendarMeeting",
]);

const preview = new Set([
  "getPlatform",
  "onPreviewText",
  "onPreviewAppend",
  "onPreviewHold",
  "onPreviewResult",
  "onPreviewHide",
  "resizeTranscriptionPreviewWindow",
  "dismissDictationPreview",
  "completeDictationPreview",
  "hideDictationPreview",
]);

const accessibilityDrop = new Set([
  "getPlatform",
  "accessibilityDropStartDrag",
  "hideAccessibilityDrop",
]);

const capabilities = {
  "control-panel": allNames.filter((name) => !windowSpecific.has(name)),
  overlay: allNames.filter(
    (name) =>
      !windowSpecific.has(name) &&
      !controlOnly.has(name) &&
      !name.toLowerCase().includes("agentconversation")
  ),
  agent: [...agent],
  notification: [...notification],
  preview: [...preview],
  "accessibility-drop": [...accessibilityDrop],
};

fs.mkdirSync(outputDir, { recursive: true });
for (const [name, allowlist] of Object.entries(capabilities)) {
  const generated = source.replace(
    "/* __VOICELAB_PRELOAD_CAPABILITIES__ */ []",
    JSON.stringify(allowlist.sort())
  );
  if (generated === source) throw new Error("Preload capability placeholder is missing");
  fs.writeFileSync(
    path.join(outputDir, `${name}.js`),
    `// Generated by scripts/generate-preloads.js. Do not edit directly.\n${generated}`
  );
}

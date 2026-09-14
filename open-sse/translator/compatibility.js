import { FORMATS } from "./formats.js";

const REMOTE_IMAGE_RE = /^https?:\/\//i;

function forEachContentBlock(body, callback) {
  for (const message of body?.messages || []) {
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) callback(block);
  }

  for (const item of body?.input || []) {
    const content = Array.isArray(item?.content) ? item.content : [item?.content];
    for (const block of content) callback(block);
  }
}

function hasInputAudio(body) {
  let found = false;
  forEachContentBlock(body, (block) => {
    if (block?.type === "input_audio" || block?.type === "audio_url") found = true;
  });
  return found;
}

function hasImage(body, { remoteOnly = false } = {}) {
  let found = false;
  forEachContentBlock(body, (block) => {
    if (block?.type !== "image_url" && block?.type !== "image" && block?.type !== "input_image") return;
    const url = typeof block.image_url === "string"
      ? block.image_url
      : block.image_url?.url || block.image_url;
    const isRemote = typeof url === "string" && REMOTE_IMAGE_RE.test(url);
    if (!remoteOnly || isRemote) found = true;
  });
  return found;
}

function hasFileReference(body) {
  let found = false;
  forEachContentBlock(body, (block) => {
    if (block?.type === "input_image" && block.file_id && !block.image_url) found = true;
  });
  return found;
}

function hasRedactedThinking(body) {
  let found = false;
  forEachContentBlock(body, (block) => {
    if (block?.type === "redacted_thinking") found = true;
  });
  return found;
}

/**
 * Return a privacy-safe, machine-readable compatibility failure for a request
 * that cannot be represented by the selected target protocol. The translator
 * itself remains pure/backward-compatible; callers use this gate before
 * dispatching to an upstream provider.
 */
export function getUnsupportedTranslation(sourceFormat, targetFormat, body, { includeRemoteImages = false } = {}) {
  if (!body || sourceFormat === targetFormat) return null;

  if (sourceFormat === FORMATS.OPENAI && targetFormat === FORMATS.CLAUDE && hasInputAudio(body)) {
    return {
      caseId: "C-01",
      code: "audio_input_unsupported",
      message: "Audio input cannot be translated to the Claude Messages protocol",
    };
  }

  if (sourceFormat === FORMATS.OPENAI && targetFormat === FORMATS.KIRO && includeRemoteImages && hasImage(body, { remoteOnly: true })) {
    return {
      caseId: "C-02",
      code: "remote_image_unresolved",
      message: "Remote image could not be safely resolved for the Kiro protocol",
    };
  }

  if (sourceFormat === FORMATS.OPENAI && targetFormat === FORMATS.CURSOR && hasImage(body)) {
    return {
      caseId: "C-03",
      code: "image_input_unsupported",
      message: "Image input cannot be represented by the Cursor AgentService protocol",
    };
  }

  if (sourceFormat === FORMATS.OPENAI && targetFormat === FORMATS.COMMANDCODE && hasImage(body)) {
    return {
      caseId: "C-04",
      code: "image_input_unsupported",
      message: "Image input cannot be represented by the CommandCode protocol",
    };
  }

  if (sourceFormat === FORMATS.OPENAI_RESPONSES && targetFormat === FORMATS.OPENAI && hasFileReference(body)) {
    return {
      caseId: "C-05",
      code: "file_reference_unresolved",
      message: "Responses file reference requires an authenticated image service",
    };
  }

  if (sourceFormat === FORMATS.CLAUDE && targetFormat === FORMATS.OPENAI && hasRedactedThinking(body)) {
    return {
      caseId: "C-06",
      code: "encrypted_thinking_unsupported",
      message: "Encrypted reasoning continuity is not supported by the OpenAI Chat protocol",
    };
  }

  return null;
}

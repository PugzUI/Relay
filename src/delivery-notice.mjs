import { LIMITS } from "./validate.mjs";

const PREFIX = "Relay pending state changed. Read current state before acting.\n";

/** Format a payload-free notice and return the exact scope rows included in it. */
export function formatDeliveryNotice(scopes, limit = LIMITS.deliveryNoticeBytes) {
  if (!Array.isArray(scopes) || !Number.isSafeInteger(limit) || limit < 1) throw new TypeError("Invalid delivery notice input");
  const included = [];
  let text = PREFIX;
  for (const scope of scopes) {
    const summary = scope.summary;
    const line = `scope ${included.length + 1}: msg=${summary.pending.msg} work=${summary.pending.work} recoverable_msg=${summary.recoverable.msg} recoverable_work=${summary.recoverable.work} revision=${summary.revision}\n`;
    if (Buffer.byteLength(text + line, "utf8") > limit) continue;
    included.push(scope);
    text += line;
  }
  return Object.freeze({ text: included.length ? text : null, scopes: Object.freeze(included) });
}

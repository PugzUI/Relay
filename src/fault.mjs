/** Safe, stable refusal returned by Relay operations. */
export class Fault extends Error {
  constructor(code, message, context) {
    super(message, context?.cause ? { cause: context.cause } : undefined);
    this.name = "Fault";
    this.code = code;
    if (context) {
      const safe = {};
      for (const key of ["id", "mid", "sid", "lease", "retryAfterMs"]) {
        if (context[key] !== undefined) safe[key] = context[key];
      }
      if (Object.keys(safe).length) this.context = safe;
    }
  }
}

export function fault(code, message, context) {
  return new Fault(code, message, context);
}

export function storageFault(error) {
  if (error instanceof Fault) return error;
  const message = String(error?.message ?? "").toLowerCase();
  if (/busy|locked/.test(message)) return new Fault("busy", "Store is busy", { cause: error });
  if (/full|disk is full|no space/.test(message))
    return new Fault("storage", "Store could not persist data", { cause: error });
  if (
    /malformed|not a database|corrupt|no such table|no such column|schema has changed/.test(message)
  )
    return new Fault("schema", "Store is damaged", { cause: error });
  if (/permission|readonly|read-only/.test(message))
    return new Fault("storage", "Store access failed", { cause: error });
  return new Fault("storage", "Store operation failed", { cause: error });
}

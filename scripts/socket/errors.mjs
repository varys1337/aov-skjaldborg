export class SocketActionSchemaError extends Error {
  constructor(message, { action = "", code = "socket-schema-error" } = {}) {
    super(message);
    this.name = "SocketActionSchemaError";
    this.action = action;
    this.code = code;
  }
}

export function unknownSocketActionError(moduleId, action, { client = false } = {}) {
  const scope = client ? "client socket action" : "socket action";
  return new SocketActionSchemaError(`Unknown ${moduleId} ${scope} "${action}"`, {
    action,
    code: "unknown-action"
  });
}

export const SERVER_NAME = 'bilibili-mcp';
export const SERVER_VERSION = '0.1.0';

export function jsonrpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

export function jsonrpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

export function publicTool(tool) {
  const { handler, title, annotations, ...rest } = tool;
  return {
    ...rest,
    title: title || tool.name,
    annotations: {
      ...(annotations || {}),
      title: title || tool.name,
    },
  };
}

export function writeMessage(stream, message) {
  stream.write(`${JSON.stringify(message)}\n`);
}

export function textResult(text) {
  return { content: [{ type: 'text', text: String(text) }] };
}

export function errorResult(text) {
  return { content: [{ type: 'text', text: String(text) }], isError: true };
}

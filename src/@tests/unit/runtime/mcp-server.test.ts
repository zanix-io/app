import { assertEquals } from '@std/assert'
import { normalize } from 'modules/manifest/normalize.ts'
import { registerOperations } from 'modules/runtime/operation-registry.ts'
import { handleMcpRequest, type JsonRpcRequest } from 'modules/runtime/mcp-server.ts'

Deno.test(
  'handleMcpRequest: "initialize" echoes back the server\'s supported protocol version',
  async () => {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    }

    const response = await handleMcpRequest(request, 'agent:test')

    assertEquals(response?.id, 1)
    assertEquals(
      (response?.result as { protocolVersion: string })?.protocolVersion,
      '2025-06-18',
    )
    assertEquals(
      (response?.result as { capabilities: { tools: unknown } })?.capabilities,
      {
        tools: {},
      },
    )
  },
)

Deno.test(
  'handleMcpRequest: "notifications/initialized" (a notification, no id) returns null — no response',
  async () => {
    const response = await handleMcpRequest(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      'agent:test',
    )

    assertEquals(response, null)
  },
)

Deno.test('handleMcpRequest: an unknown method is a JSON-RPC protocol error (-32601)', async () => {
  const response = await handleMcpRequest(
    { jsonrpc: '2.0', id: 2, method: 'never/heard-of-it' },
    'agent:test',
  )

  assertEquals(response?.error?.code, -32601)
  assertEquals(response?.result, undefined)
})

Deno.test(
  'handleMcpRequest: "tools/list" surfaces every mcp-declared operation across every active app',
  async () => {
    const def = normalize({
      name: 'mcp-server-list-target',
      operations: {
        createReview: {
          handler: () => Promise.resolve('ok'),
          mcp: {
            description: 'Creates a review.',
            inputSchema: { type: 'object' },
          },
        },
        internalOnly: () => Promise.resolve('ok'), // never exposed — no `mcp` declared
      },
    })
    registerOperations(def, new Map())

    const response = await handleMcpRequest(
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      'agent:test',
    )

    const tools = (response?.result as { tools: { name: string }[] }).tools
    const names = tools.map((t) => t.name)
    assertEquals(names.includes('mcp-server-list-target.createReview'), true)
    assertEquals(names.includes('mcp-server-list-target.internalOnly'), false)
  },
)

Deno.test(
  'handleMcpRequest: "tools/call" with an unknown tool name is a JSON-RPC protocol error (-32602)',
  async () => {
    const response = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'never-registered.op' },
      },
      'agent:test',
    )

    assertEquals(response?.error?.code, -32602)
  },
)

Deno.test(
  'handleMcpRequest: "tools/call" with no "name" param is a JSON-RPC protocol error (-32602)',
  async () => {
    const response = await handleMcpRequest(
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: {} },
      'agent:test',
    )

    assertEquals(response?.error?.code, -32602)
  },
)

Deno.test(
  'handleMcpRequest: "tools/call" invokes the operation and wraps its return value as text content',
  async () => {
    const def = normalize({
      name: 'mcp-server-call-target',
      operations: {
        echo: {
          handler: (payload: unknown) => Promise.resolve({ echoed: payload }),
          mcp: { description: 'Echoes its input.' },
        },
      },
    })
    registerOperations(def, new Map())

    const response = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'mcp-server-call-target.echo',
          arguments: { text: 'hi' },
        },
      },
      'agent:test',
    )

    const result = response?.result as {
      content: { type: string; text: string }[]
    }
    assertEquals(result.content, [{
      type: 'text',
      text: JSON.stringify({ echoed: { text: 'hi' } }),
    }])
  },
)

Deno.test(
  'handleMcpRequest: "tools/call" denied by allowedCallers is a TOOL EXECUTION error ' +
    '(isError: true in a successful result), never a JSON-RPC protocol error',
  async () => {
    const def = normalize({
      name: 'mcp-server-scoped-target',
      operations: {
        secretOp: {
          handler: () => Promise.resolve('secret'),
          allowedCallers: ['agent:trusted'],
          mcp: { description: 'A scoped tool.' },
        },
      },
    })
    registerOperations(def, new Map())

    const response = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'mcp-server-scoped-target.secretOp' },
      },
      'agent:untrusted',
    )

    assertEquals(response?.error, undefined)
    const result = response?.result as {
      isError: boolean
      content: { text: string }[]
    }
    assertEquals(result.isError, true)
    assertEquals(result.content[0].text.includes('agent:untrusted'), true)
  },
)

Deno.test(
  'handleMcpRequest: "tools/call" for an allowed caller succeeds normally',
  async () => {
    const def = normalize({
      name: 'mcp-server-scoped-allowed',
      operations: {
        secretOp: {
          handler: () => Promise.resolve('secret'),
          allowedCallers: ['agent:trusted'],
          mcp: { description: 'A scoped tool.' },
        },
      },
    })
    registerOperations(def, new Map())

    const response = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'mcp-server-scoped-allowed.secretOp' },
      },
      'agent:trusted',
    )

    const result = response?.result as {
      isError?: boolean
      content: { text: string; type: string }[]
    }
    assertEquals(result.isError, undefined)
    assertEquals(result.content, [{
      type: 'text',
      text: JSON.stringify('secret'),
    }])
  },
)

Deno.test(
  'handleMcpRequest: "tools/call" whose handler throws is a TOOL EXECUTION error, not a crash',
  async () => {
    const def = normalize({
      name: 'mcp-server-throwing-target',
      operations: {
        boom: {
          handler: () => Promise.reject(new Error('kaboom')),
          mcp: { description: 'Always fails.' },
        },
      },
    })
    registerOperations(def, new Map())

    const response = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'mcp-server-throwing-target.boom' },
      },
      'agent:test',
    )

    const result = response?.result as {
      isError: boolean
      content: { text: string }[]
    }
    assertEquals(result.isError, true)
    assertEquals(result.content[0].text.includes('kaboom'), true)
  },
)

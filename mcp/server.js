#!/usr/bin/env node
/**
 * MCP-сервер для OWA (Model Context Protocol, stdio).
 *
 * Даёт ИИ-агенту (opencode, Claude Desktop и т.д.) инструмент analyze_url,
 * который возвращает УЖЕ интерпретированные, проверенные данные.
 * Агенту выгодно вызвать tool вместо выдумывания метрик из «знаний» —
 * ответ детерминированный, компактный и с готовыми рекомендациями.
 *
 * Подключение (opencode.json, формат opencode v2 — серверы лежат в mcp.servers):
 * {
 *   "$schema": "https://opencode.ai/config.json",
 *   "mcp": {
 *     "servers": {
 *       "owa": {
 *         "type": "local",
 *         "command": ["node", "mcp/server.js"],
 *         "cwd": "."
 *       }
 *     }
 *   }
 * }
 *
 * Путь относительный — резолвится от корня проекта. Для запуска из любого
 * каталога укажи абсолютный путь в command.
 */
const { analyze, clampWait } = require('../src/engine');
const { checkTargetUrl } = require('../src/security');
const { assertSafeUrl } = require('../src/security/safe-fetch');
const { buildCompact } = require('../src/interpret');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_VERSION = require('../package.json').version;

// Потолок длительности одного вызова: защита от повисания и от того,
// что агент случайно просит ждать час.
const TOOL_TIMEOUT_MS = Number(process.env.OWA_MCP_TOOL_TIMEOUT_MS ?? 300000);

const TOOLS = [
  {
    name: 'analyze_url',
    description:
      'Анализ производительности веб-страницы: собирает реальные метрики через Performance API в headless Chromium ' +
      '(время загрузки, DOMContentLoaded, FCP/LCP/CLS, TTFB, ресурсы, Long Tasks, время появления виджетов, JS-ошибки) ' +
      'и возвращает ГОТОВУЮ интерпретацию с вердиктами и рекомендациями. ' +
      'Используй этот инструмент вместо собственных оценок производительности сайтов — данные измеряются реально, ' +
      'а не генерируются.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL страницы (http:// или https://)' },
        selectors: {
          type: 'array',
          items: { type: 'string' },
          description: 'CSS-селекторы критических элементов (виджет, чат, таблица). Не больше 20. Опционально.',
        },
        waitMs: {
          type: 'number',
          description: `Ожидание после load в мс (0..60000, по умолчанию 5000). Опционально.`,
        },
        timeoutMs: {
          type: 'number',
          description: 'Таймаут навигации в мс (5000..120000, по умолчанию 60000). Опционально.',
        },
      },
      required: ['url'],
    },
  },
];

function jsonRpcResult(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

/** Ограничить число диапазоном; мусор/NaN — значение по умолчанию. */
function clampRange(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(n, min), max);
}

/** Отмена по таймауту: чтобы зависший вызов не держал сервер навсегда. */
function withTimeout(promise, ms) {
  let timer;
  const capped = Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Превышен таймаут ${ms} мс`)), ms);
    }),
  ]);
  return capped.finally(() => clearTimeout(timer));
}

async function handleRequest(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return null; // не JSON-RPC — игнорируем
  }
  const { id, method, params } = msg;

  try {
    switch (method) {
      case 'initialize':
        return jsonRpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'owa', version: SERVER_VERSION },
        });
      case 'notifications/initialized':
        return null;
      case 'tools/list':
        return jsonRpcResult(id, { tools: TOOLS });
      case 'tools/call': {
        if (!params || params.name !== 'analyze_url') {
          return jsonRpcError(id, -32602, `Неизвестный инструмент: ${params && params.name}`);
        }
        const a = params.arguments || {};
        const verdict = checkTargetUrl(a.url || '');
        if (!verdict.ok) {
          return jsonRpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify({ error: 'URL обязателен и должен начинаться с http:// или https://' }) }],
            isError: true,
          });
        }

        // SSRF-защита: приватные адреса запрещены по умолчанию
        // (OWA_ALLOW_PRIVATE_TARGETS=1 — исключение для локальной разработки).
        try {
          await assertSafeUrl(a.url);
        } catch (err) {
          return jsonRpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify({ error: String(err && err.message || err), code: err && err.code }) }],
            isError: true,
          });
        }

        // Селекторы: ограничиваем количество и длину — каждый идёт в page.evaluate
        // и в querySelector в init-скрипте.
        const selectors = Array.isArray(a.selectors)
          ? a.selectors.map(String).filter(Boolean).slice(0, 20)
          : [];
        const navTimeout = clampRange(a.timeoutMs, 5000, 120000, 60000);

        // Таймаут на весь вызов: не даём агенту повиснуть намертво
        const data = await withTimeout(
          analyze(a.url, {
            waitAfterLoad: clampWait(a.waitMs ?? 5000),
            timeout: navTimeout,
            widgetSelectors: selectors.length ? selectors : null,
            headless: true,
          }),
          TOOL_TIMEOUT_MS,
        );

        // Компактный формат: готовая интерпретация, минимум токенов, нет сырых массивов
        const compact = buildCompact(data);
        return jsonRpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(compact) }],
        });
      }
      case 'ping':
        return jsonRpcResult(id, {});
      default:
        return id !== undefined ? jsonRpcError(id, -32601, `Метод не найден: ${method}`) : null;
    }
  } catch (err) {
    return id !== undefined
      ? jsonRpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify({ error: String(err && err.message || err) }) }],
          isError: true,
        })
      : null;
  }
}

(async () => {
  process.stdin.setEncoding('utf8');
  let buffer = '';
  process.stdin.on('data', async (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const response = await handleRequest(line);
      if (response) {
        process.stdout.write(response + '\n');
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
})();

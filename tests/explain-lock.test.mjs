// The /explain lock must refuse every tool that changes something, whatever the model decides,
// and keep reads, searches and proposals. Unknown tools are refused (allow-list).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODIFYING_TOOLS } from '../lib/rules.js';

const blocked = name => MODIFYING_TOOLS.test(name);

test('/explain refuses writes, commands, delegation and unknown tools', () => {
  for (const n of ['bash', 'pwsh', 'write', 'edit', 'apply_patch', 'subagent', 'workflow',
    'plugin_manager', 'send_message', 'a_tool_added_later', 'mcp__server__write_file']) {
    assert.ok(blocked(n), `${n} must be refused under /explain`);
  }
});

test('/explain keeps reads, searches and proposals', () => {
  for (const n of ['read', 'grep', 'glob', 'web_search', 'web_fetch', 'pdf_read', 'skill', 'mcp__server__read']) {
    assert.ok(!blocked(n), `${n} must stay available under /explain`);
  }
});

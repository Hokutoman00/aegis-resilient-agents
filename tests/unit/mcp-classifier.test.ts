import { describe, expect, test } from 'bun:test';
import { classifyTool, hedgePolicyFor } from '../../src/mcp/classifier.js';

describe('MCP classifyTool', () => {
  test('x-aegis-idempotent=true wins over any name pattern', () => {
    const c = classifyTool({ name: 'delete_everything', 'x-aegis-idempotent': true });
    expect(c.klass).toBe('READ_HEDGE');
    expect(c.source).toBe('annotation');
  });

  test('x-aegis-idempotent=false wins over read-looking name', () => {
    const c = classifyTool({ name: 'get_secret', 'x-aegis-idempotent': false });
    expect(c.klass).toBe('WRITE_TIED');
    expect(c.source).toBe('annotation');
  });

  test('read prefixes → READ_HEDGE', () => {
    for (const name of [
      'get_user',
      'read_file',
      'search_web',
      'list_buckets',
      'query_db',
      'find_doc',
      'fetch_page',
      'describe_table',
      'count_rows',
    ]) {
      const c = classifyTool({ name });
      expect(c.klass).toBe('READ_HEDGE');
      expect(c.source).toBe('name_pattern');
    }
  });

  test('write prefixes → WRITE_TIED', () => {
    for (const name of [
      'create_user',
      'send_email',
      'delete_file',
      'update_record',
      'post_message',
      'put_object',
      'patch_doc',
      'remove_item',
      'insert_row',
      'move_file',
      'rename_branch',
    ]) {
      const c = classifyTool({ name });
      expect(c.klass).toBe('WRITE_TIED');
      expect(c.source).toBe('name_pattern');
    }
  });

  test('ambiguous names → UNKNOWN_TIED (conservative default)', () => {
    const c = classifyTool({ name: 'do_thing' });
    expect(c.klass).toBe('UNKNOWN_TIED');
    expect(c.source).toBe('default');
  });

  test('case-insensitive within snake_case: GET_user still maps to READ_HEDGE', () => {
    expect(classifyTool({ name: 'GET_user' }).klass).toBe('READ_HEDGE');
    expect(classifyTool({ name: 'SEND_alert' }).klass).toBe('WRITE_TIED');
  });
});

describe('MCP hedgePolicyFor', () => {
  test('READ_HEDGE → parallel fire, no idempotency key', () => {
    const p = hedgePolicyFor('READ_HEDGE');
    expect(p.fire_in_parallel).toBe(true);
    expect(p.retry_with_idempotency_key).toBe(false);
  });

  test('WRITE_TIED → tied (no parallel), idempotency key on retry', () => {
    const p = hedgePolicyFor('WRITE_TIED');
    expect(p.fire_in_parallel).toBe(false);
    expect(p.retry_with_idempotency_key).toBe(true);
  });

  test('UNKNOWN_TIED → conservative (same as WRITE_TIED)', () => {
    const p = hedgePolicyFor('UNKNOWN_TIED');
    expect(p.fire_in_parallel).toBe(false);
    expect(p.retry_with_idempotency_key).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { buildServer } from '../../server.js';
import { CHAT_SYSTEM } from './tools.js';

/**
 * The persona gate is the whole product rule here: Competition AI is for
 * enrolled students. An unauthenticated caller must not reach the model at all —
 * every turn costs money and touches the repository.
 */
describe('Competition AI access', () => {
  it('refuses an unauthenticated ask', async () => {
    const app = await buildServer();
    const response = await app.inject({
      method: 'POST',
      url: '/chat',
      payload: { message: 'what can I enter?' },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('refuses unauthenticated history reads', async () => {
    const app = await buildServer();
    const response = await app.inject({ method: 'GET', url: '/chat/abc' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

describe('Competition AI system prompt', () => {
  // These are the properties that keep the assistant from inventing a
  // competition or asserting a date it never verified.
  it('forbids answering from the model’s own knowledge', () => {
    expect(CHAT_SYSTEM).toMatch(/only source|no competition knowledge of your own/i);
    expect(CHAT_SYSTEM).toMatch(/never fill the gap from general knowledge/i);
  });

  it('requires flagging unverified dates and missing fields', () => {
    expect(CHAT_SYSTEM).toMatch(/lastVerifiedAt/);
    expect(CHAT_SYSTEM).toMatch(/not recorded|not verified/i);
  });

  it('requires leading with ineligibility', () => {
    expect(CHAT_SYSTEM).toMatch(/not eligible/i);
  });
});

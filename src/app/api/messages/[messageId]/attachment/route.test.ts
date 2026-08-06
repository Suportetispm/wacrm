import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  messagesMaybeSingle: vi.fn(),
  conversationsMaybeSingle: vi.fn(),
  createSignedUrl: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn((err: { status?: number; message?: string }) =>
    Response.json({ error: err?.message ?? 'error' }, { status: err?.status ?? 500 }),
  ),
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            table === 'messages' ? mocks.messagesMaybeSingle() : mocks.conversationsMaybeSingle(),
        }),
      }),
    }),
    storage: {
      from: () => ({
        createSignedUrl: mocks.createSignedUrl,
      }),
    },
  }),
}));

import { GET } from './route';

const VALID_UUID = '11111111-1111-1111-1111-111111111111';
const ctx = {
  supabase: { name: 'scoped-client' },
  accountId: 'account-1',
  userId: 'user-1',
  role: 'agent',
  account: { id: 'account-1', name: 'Acme' },
};

function params(messageId: string) {
  return { params: Promise.resolve({ messageId }) };
}

const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

beforeEach(() => {
  mocks.requireRole.mockReset();
  mocks.messagesMaybeSingle.mockReset();
  mocks.conversationsMaybeSingle.mockReset();
  mocks.createSignedUrl.mockReset();
  mocks.requireRole.mockResolvedValue(ctx);
  consoleErrorSpy.mockClear();
  consoleLogSpy.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

const documentMessage = {
  id: VALID_UUID,
  conversation_id: 'conversation-1',
  content_type: 'document',
  media_storage_path: 'account-1/conversation-1/hash.pdf',
  media_file_name: 'invoice.pdf',
  media_mime_type: 'application/pdf',
  media_file_size: 123456,
};

describe('GET /api/messages/[messageId]/attachment', () => {
  it('returns 401 when there is no session', async () => {
    mocks.requireRole.mockRejectedValue({ status: 401, message: 'Unauthorized' });

    const res = await GET(new Request('http://localhost'), params(VALID_UUID));

    expect(res.status).toBe(401);
    expect(mocks.messagesMaybeSingle).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed message id', async () => {
    const res = await GET(new Request('http://localhost'), params('not-a-uuid'));

    expect(res.status).toBe(400);
    expect(mocks.messagesMaybeSingle).not.toHaveBeenCalled();
  });

  it('returns 403 when the message belongs to a different account', async () => {
    mocks.messagesMaybeSingle.mockResolvedValue({ data: documentMessage, error: null });
    mocks.conversationsMaybeSingle.mockResolvedValue({
      data: { account_id: 'account-2' },
      error: null,
    });

    const res = await GET(new Request('http://localhost'), params(VALID_UUID));

    expect(res.status).toBe(403);
    expect(mocks.createSignedUrl).not.toHaveBeenCalled();
  });

  it('returns 404 when the message does not exist', async () => {
    mocks.messagesMaybeSingle.mockResolvedValue({ data: null, error: null });

    const res = await GET(new Request('http://localhost'), params(VALID_UUID));

    expect(res.status).toBe(404);
    expect(mocks.conversationsMaybeSingle).not.toHaveBeenCalled();
  });

  it('returns 404 when the message has no storage path', async () => {
    mocks.messagesMaybeSingle.mockResolvedValue({
      data: { ...documentMessage, media_storage_path: null },
      error: null,
    });
    mocks.conversationsMaybeSingle.mockResolvedValue({
      data: { account_id: 'account-1' },
      error: null,
    });

    const res = await GET(new Request('http://localhost'), params(VALID_UUID));

    expect(res.status).toBe(404);
    expect(mocks.createSignedUrl).not.toHaveBeenCalled();
  });

  it('returns 415 for a non-PDF attachment', async () => {
    mocks.messagesMaybeSingle.mockResolvedValue({
      data: { ...documentMessage, content_type: 'image', media_mime_type: 'image/png' },
      error: null,
    });
    mocks.conversationsMaybeSingle.mockResolvedValue({
      data: { account_id: 'account-1' },
      error: null,
    });

    const res = await GET(new Request('http://localhost'), params(VALID_UUID));

    expect(res.status).toBe(415);
    expect(mocks.createSignedUrl).not.toHaveBeenCalled();
  });

  it('signs a 60-second URL and never returns the storage path or service_role', async () => {
    mocks.messagesMaybeSingle.mockResolvedValue({ data: documentMessage, error: null });
    mocks.conversationsMaybeSingle.mockResolvedValue({
      data: { account_id: 'account-1' },
      error: null,
    });
    mocks.createSignedUrl.mockResolvedValue({
      data: { signedUrl: 'https://storage.example/signed?token=abc' },
      error: null,
    });

    const res = await GET(new Request('http://localhost'), params(VALID_UUID));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mocks.createSignedUrl).toHaveBeenCalledWith(documentMessage.media_storage_path, 60);
    expect(body).toEqual({
      url: 'https://storage.example/signed?token=abc',
      fileName: 'invoice.pdf',
      mimeType: 'application/pdf',
      fileSize: 123456,
    });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('media_storage_path');
    expect(raw.toLowerCase()).not.toContain('service_role');
  });

  it('never logs the storage path, signed URL, or message id', async () => {
    mocks.messagesMaybeSingle.mockResolvedValue({ data: documentMessage, error: null });
    mocks.conversationsMaybeSingle.mockResolvedValue({
      data: { account_id: 'account-2' },
      error: null,
    });

    await GET(new Request('http://localhost'), params(VALID_UUID));

    const loggedText = [...consoleErrorSpy.mock.calls, ...consoleLogSpy.mock.calls]
      .flat()
      .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join(' ');
    expect(loggedText).not.toContain(documentMessage.media_storage_path);
    expect(loggedText).not.toContain(VALID_UUID);
  });
});

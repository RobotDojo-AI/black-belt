import { defineTool, ok, err } from '../registry.js';

defineTool('request_credential', {
  description: 'Ask the user for an API key, password, or other secret through a password-masked input above the chat composer. The value is written directly to macOS Keychain — it never enters chat history, LLM context, or logs. Use when a service requires a credential you don\'t have. You will receive `{stored: true, service}` on success; you will never see the value.',
  parameters: {
    properties: {
      service: {
        type: 'string',
        description: 'Canonical Keychain service name (uppercase snake_case, e.g. STRIPE_SECRET_KEY).',
      },
      label: {
        type: 'string',
        description: 'Short human-readable label for the input field (e.g. "Stripe secret key").',
      },
      purpose: {
        type: 'string',
        description: 'One-sentence reason the credential is needed.',
      },
    },
    required: ['service', 'label'],
  },
  async execute({ service, label, purpose }, ctx) {
    const sessionId = ctx?.sessionId;
    if (!sessionId) {
      return err('request_credential requires an authenticated chat session');
    }
    const {
      createRequest, waitForResolution,
    } = await import('../../secure-input.js');

    let out;
    try {
      out = createRequest({ sessionId, service, label, purpose: purpose || null });
    } catch (e) {
      return err(`cannot create request: ${e.message}`);
    }

    // The chat SSE layer emits the 'secure_input' frame based on the
    // `action: 'secure_input'` return value. The handler will wait for the
    // DB row to flip before returning the final tool result.
    return ok({
      action: 'secure_input',
      requestId: out.requestId,
      service,
      label,
      expiresAt: out.expiresAt,
      _awaitResolution: true,
      _onResolved: async () => {
        const resolved = await waitForResolution(out.requestId);
        if (resolved.status === 'submitted')  return ok({ stored: true, service });
        if (resolved.status === 'cancelled')  return ok({ cancelled: true, service });
        if (resolved.status === 'expired')    return ok({ expired: true, service });
        return err(`request resolved as ${resolved.status}`);
      },
    });
  },
});

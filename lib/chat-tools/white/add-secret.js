import { defineTool, ok, err } from '../registry.js';

defineTool('add_secret', {
  description: 'Securely save an API key or secret to Keychain. Opens a masked input overlay — the value is never stored in chat history or shown to the AI.',
  parameters: {
    properties: {
      service: {
        type: 'string',
        description: 'Key name in UPPER_SNAKE_CASE (e.g. STRIPE_SECRET_KEY, OPENAI_API_KEY)',
      },
      label: {
        type: 'string',
        description: 'Human-readable label shown in the input overlay (e.g. "Stripe Secret Key")',
      },
    },
    required: ['service', 'label'],
  },
  async execute({ service, label }, ctx) {
    const { createRequest } = await import('../../secure-input.js');

    let requestId, expiresAt;
    try {
      ({ requestId, expiresAt } = createRequest({
        sessionId: ctx.sessionId,
        service,
        label,
        purpose: 'add-secret via chat',
      }));
    } catch (e) {
      return err(e.message || 'failed to create secure input request');
    }

    // routes/chat.js detects action:'secure_input' and emits the overlay event.
    return ok({
      action: 'secure_input',
      requestId,
      service,
      label,
      expiresAt,
    });
  },
});

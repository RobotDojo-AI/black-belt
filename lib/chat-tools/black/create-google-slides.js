import { defineTool, ok, err } from '../registry.js';

defineTool('create_google_slides', {
  description: 'Create a Google Slides presentation. Pass a list of slides with title and body text for each. Returns the presentation URL. Black Belt feature.',
  belt: 'black',
  parameters: {
    properties: {
      title: {
        type: 'string',
        description: 'Presentation title',
      },
      slides: {
        type: 'array',
        description: 'Array of slides. Each slide has a title and body.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Slide heading' },
            body: { type: 'string', description: 'Slide body text' },
          },
          required: ['title'],
        },
      },
      account_email: {
        type: 'string',
        description: 'Google account to create the presentation in. Omit to use the primary account.',
      },
    },
    required: ['title', 'slides'],
  },
  async execute({ title, slides, account_email }) {
    let accountEmail = account_email;
    if (!accountEmail) {
      try {
        const { listConnectedGoogleAccounts } = await import('../../google-oauth.js');
        const accounts = await listConnectedGoogleAccounts();
        if (!accounts.length) return err('No Google accounts connected. Connect an account first.');
        accountEmail = accounts[0];
      } catch (e) {
        return err(`Could not resolve Google account: ${e.message}`);
      }
    }

    try {
      const { createPresentation } = await import('../../google-slides.js');
      const result = await createPresentation({ title, slides: slides || [], accountEmail });
      return ok({
        url: result.url,
        presentation_id: result.presentationId,
        message: `Created: ${result.url}`,
      });
    } catch (e) {
      return err(`Failed to create presentation: ${e.message}`);
    }
  },
});

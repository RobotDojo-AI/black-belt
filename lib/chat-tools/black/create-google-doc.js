import { defineTool, ok, err } from '../registry.js';

defineTool('create_google_doc', {
  description: 'Create a new Google Doc. Accepts markdown content — headings, bold, and paragraphs are preserved. Returns the doc URL. Black Belt feature.',
  belt: 'black',
  parameters: {
    properties: {
      title: {
        type: 'string',
        description: 'Document title',
      },
      content: {
        type: 'string',
        description: 'Document content in markdown. # = Heading 1, ## = Heading 2, **bold** = bold.',
      },
      account_email: {
        type: 'string',
        description: 'Google account to create the doc in (e.g. you@gmail.com). Omit to use the primary account.',
      },
      folder_id: {
        type: 'string',
        description: 'Google Drive folder ID to place the doc in. Omit for root Drive.',
      },
    },
    required: ['title'],
  },
  async execute({ title, content, account_email, folder_id }) {
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
      const { createGoogleDoc } = await import('../../google-docs.js');
      const result = await createGoogleDoc({
        title,
        content: content || '',
        accountEmail,
        folderId: folder_id || null,
      });
      return ok({ url: result.url, doc_id: result.docId, message: `Created: ${result.url}` });
    } catch (e) {
      return err(`Failed to create doc: ${e.message}`);
    }
  },
});

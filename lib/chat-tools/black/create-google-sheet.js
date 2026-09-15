import { defineTool, ok, err } from '../registry.js';

defineTool('create_google_sheet', {
  description: 'Create a new Google Sheet from structured data. Pass headers and rows. Returns the sheet URL. Black Belt feature.',
  belt: 'black',
  parameters: {
    properties: {
      title: {
        type: 'string',
        description: 'Spreadsheet title',
      },
      headers: {
        type: 'array',
        items: { type: 'string' },
        description: 'Column header labels (e.g. ["Name", "Email", "Company"])',
      },
      data: {
        type: 'array',
        items: { type: 'array' },
        description: 'Array of rows, each row an array of cell values (e.g. [["Alice", "alice@co.com", "Acme"]])',
      },
      account_email: {
        type: 'string',
        description: 'Google account to create the sheet in. Omit to use the primary account.',
      },
    },
    required: ['title'],
  },
  async execute({ title, headers, data, account_email }) {
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
      const { createGoogleSheet } = await import('../../google-sheets.js');
      const result = await createGoogleSheet({
        title,
        headers: headers || [],
        data: data || [],
        accountEmail,
      });
      return ok({ url: result.url, sheet_id: result.sheetId, message: `Created: ${result.url}` });
    } catch (e) {
      return err(`Failed to create sheet: ${e.message}`);
    }
  },
});

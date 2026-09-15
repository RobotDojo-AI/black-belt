import db from '../../db.js';
import { defineTool, ok, err } from '../registry.js';
import { enrichPersonFromLinkedIn } from '../../linkedin-scraper.js';

defineTool('enrich_from_linkedin', {
  description:
    'Search LinkedIn for a person\'s public profile using their work email domain for disambiguation, ' +
    'then save the LinkedIn URL to their record. Requires work_email_domain or a non-freemail address ' +
    'in person_identifiers. Skips people who already have a linkedin_url.',
  parameters: {
    properties: {
      person_id: {
        type: 'string',
        description: 'Person ID to enrich. Use search_people first to find the ID.',
      },
    },
    required: ['person_id'],
  },
  async execute({ person_id }) {
    if (!person_id) return err('person_id is required');

    const { updated, profile } = await enrichPersonFromLinkedIn(person_id, db);

    if (!updated && !profile) {
      // Distinguish "already done" from "not found"
      const person = db.prepare('SELECT display_name, linkedin_url FROM people WHERE id = ?').get(person_id);
      if (!person) return err(`Person ${person_id} not found`);
      if (person.linkedin_url) {
        return ok({
          updated: false,
          message: `${person.display_name} already has a LinkedIn URL.`,
          linkedin_url: person.linkedin_url,
        });
      }
      return ok({
        updated: false,
        message: `No LinkedIn profile found for ${person.display_name}. ` +
          'Check that work_email_domain is set or they have a non-freemail address.',
      });
    }

    return ok({
      updated: true,
      message: `Enriched ${profile.name || person_id}`,
      profile: {
        name:        profile.name,
        headline:    profile.headline,
        employer:    profile.employer,
        location:    profile.location,
        linkedin_url: profile.linkedinUrl,
        fetched_at:  profile.fetchedAt,
      },
    });
  },
});

import { listVoices } from '../../voices.js';
import { defineTool, ok } from '../registry.js';

defineTool('list_voices', {
  description: 'List your available voice profiles for writing in different styles',
  parameters: { properties: {}, required: [] },
  execute() {
    const voices = listVoices();
    return ok({ voices, count: voices.length });
  },
});

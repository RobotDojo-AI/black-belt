/**
 * Generic router — used when the classifier can't decide. The file is indexed
 * and preserved under Uncategorized until reclassify moves it.
 */
import { unknownTopicPair } from '../topic-routing-policy.js';

export async function routeGeneric() {
  const { t1, t2 } = unknownTopicPair();
  return {
    doc_type: 'other',
    topic_t1: t1,
    topic_t2: t2,
    extracted_json: null,
    entity_refs: null,
    confidence: 0.1,
    prompt_user: 'Not sure what this is — can you tell me in one sentence?',
  };
}

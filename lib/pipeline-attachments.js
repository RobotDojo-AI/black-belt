export function normalizePipelineAttachments(meta = {}) {
  return {
    primary_target: meta.primary_target || null,
    workbench_id: meta.workbench_id || null,
    related_targets: Array.isArray(meta.related_targets) ? meta.related_targets : [],
  };
}

export function attachPipelineRecord(meta = {}, attachment = {}) {
  const next = { ...meta };
  if (attachment.primary_target) next.primary_target = attachment.primary_target;
  if (attachment.workbench_id) next.workbench_id = attachment.workbench_id;
  if (attachment.related_targets) next.related_targets = [...attachment.related_targets];
  if (!Array.isArray(next.related_targets)) next.related_targets = [];
  return next;
}

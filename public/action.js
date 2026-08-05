const OWNER_LABELS = {
  decision: 'You decide',
  task: 'You do',
  approval: 'Agent acts after approval',
}

function owner(entity) {
  if (OWNER_LABELS[entity?.action_owner]) return entity.action_owner
  if (entity?.kind === 'question') return 'decision'
  return entity?.options?.length ? 'decision' : 'task'
}

export function actionOwnerLabel(entity) {
  return OWNER_LABELS[owner(entity)]
}

export function actionCategory(entity) {
  return owner(entity) === 'task' ? 'task' : 'decision'
}

export function changeKind(entity, lastVisitAt) {
  if (!lastVisitAt) return null
  const prior = Date.parse(lastVisitAt)
  if (!Number.isFinite(prior)) return null
  const created = Date.parse(entity?.created_at)
  if (Number.isFinite(created) && created > prior) return 'new'
  const updated = Date.parse(entity?.updated_at)
  return Number.isFinite(updated) && updated > prior ? 'changed' : null
}

export function responseLabel(entity) {
  const kind = entity?.reply_kind ?? entity?.annotation_kind
  if (kind === 'clarify') return 'Clarification requested'
  if (kind === 'decline') return 'Declined'
  if (entity?.handled_at) return 'You did your part'
  if (kind === 'answer' || entity?.reply || entity?.annotation) return 'You answered'
  return ''
}

function latestIso(...values) {
  return values
    .filter(Boolean)
    .map((value) => ({ value, at: Date.parse(value) }))
    .filter(({ at }) => Number.isFinite(at))
    .sort((a, b) => b.at - a.at)[0]?.value ?? null
}

export function agentFollowupChip(model, nowMs) {
  if (!model?.answered || !model?.pickedUp || !model?.pickedUpAt) return null
  const age = nowMs - Date.parse(model.pickedUpAt)
  if (age >= 60 * 60_000) {
    return { text: `agent overdue ${relative(age)}`, tone: age >= 4 * 60 * 60_000 ? 'hot' : 'warm' }
  }
  return { text: `picked up ${relative(age)}`, tone: 'muted' }
}

function relative(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 1) return 'moments'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export function lifecycleReceipt(entity) {
  const steps = []
  const askedAt = entity?.action_started_at ?? entity?.created_at
  if (askedAt) steps.push({ label: 'Asked', at: askedAt })
  const response = responseLabel(entity)
  const responseAt = latestIso(entity?.replied_at, entity?.annotated_at, entity?.handled_at)
  if (response) steps.push({ label: response, at: responseAt })
  const pickupAt = latestIso(entity?.reply_seen_at, entity?.annotation_seen_at, entity?.handled_seen_at)
  if (pickupAt) steps.push({ label: 'Agent picked up', at: pickupAt })
  if (entity?.outcome) steps.push({ label: entity.outcome, at: entity.outcome_at })
  return steps
}

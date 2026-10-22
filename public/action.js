const OWNER_LABELS = {
  decision: 'Decision',
  task: 'To do',
  approval: 'Ready after approval',
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

export function itemAnnotationReceipt(entity) {
  const text = typeof entity?.annotation === 'string' ? entity.annotation : ''
  const stamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
  const savedAt = stamp(entity?.annotated_at)
  const cleared = entity?.annotation === '' && savedAt !== null
  if (!text && !cleared) return null
  const seenAt = stamp(entity?.annotation_seen_at)
  const tracked = Object.hasOwn(entity, 'annotation_seen_at')
    && (entity.annotation_seen_at === null || seenAt !== null)
  return {
    text,
    cleared,
    savedAt,
    seenAt,
    seenBy: seenAt && typeof entity.annotation_seen_by === 'string' ? entity.annotation_seen_by : null,
    state: seenAt ? 'picked' : !tracked ? 'untracked'
      : entity.status === 'open' ? 'waiting'
        : entity.status === 'resolved' || entity.status === 'dismissed' ? 'closed' : 'untracked',
  }
}

export function agentFollowupChip(model, nowMs) {
  if (!model?.answered || !model?.pickedUp || !model?.pickedUpAt) return null
  const age = nowMs - Date.parse(model.pickedUpAt)
  if (age >= 60 * 60_000) {
    return { text: `follow-up due ${relative(age)}`, tone: age >= 4 * 60 * 60_000 ? 'hot' : 'warm' }
  }
  return { text: `delivered ${relative(age)}`, tone: 'muted' }
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
  if (askedAt) steps.push({ kind: 'asked', label: 'Asked', at: askedAt })
  if (entity?.kind === 'note' || entity?.kind === 'done') {
    const note = itemAnnotationReceipt(entity)
    if (note) steps.push({ kind: 'response', label: note.cleared ? 'Note cleared' : 'Note saved', at: note.savedAt })
    if (note?.seenAt) steps.push({ kind: 'pickup', label: 'Note delivered to an agent', at: note.seenAt })
  } else {
    // An item's note is a separate channel, unlike a board row's answer annotation.
    const responseEntity = entity?.kind === 'question'
      ? { reply: entity.reply, reply_kind: entity.reply_kind, replied_at: entity.replied_at, reply_seen_at: entity.reply_seen_at }
      : entity
    const response = responseLabel(responseEntity)
    const responseAt = latestIso(responseEntity?.replied_at, responseEntity?.annotated_at, responseEntity?.handled_at)
    if (response) steps.push({ kind: 'response', label: response, at: responseAt })
    const pickupAt = latestIso(responseEntity?.reply_seen_at, responseEntity?.annotation_seen_at, responseEntity?.handled_seen_at)
    if (pickupAt && (entity?.kind !== 'question' || response)) {
      steps.push({ kind: 'pickup', label: 'Delivered to an agent', at: pickupAt })
    }
  }
  if (entity?.outcome) steps.push({ kind: 'outcome', label: entity.outcome, at: entity.outcome_at })
  return steps
}

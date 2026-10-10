export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function timestamp(value) {
  if (value === null || value === undefined) return null;
  const ms = typeof value === 'number' ? value * 1000 : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
export function summary(item, scope) {
  if (!item || typeof item.id !== 'string' || !item.id) throw new Error('Invalid conversation directory item');
  return {id:item.id, title:String(item.title ?? ''), updated:timestamp(item.update_time ?? item.updated_at),
    assistantUpdated:timestamp(item.latest_assistant_turn_created_at),
    project:item.gizmo_id ?? item.project_id ?? item.conversation_template_id ?? item.workspace_id ?? null, scope};
}
function plainText(content) {
  if (!content || typeof content !== 'object') return '';
  const parts = content.parts ?? (typeof content.text === 'string' ? [content.text] : []);
  if (!Array.isArray(parts)) throw new Error('Invalid message content parts');
  return parts.filter(p => typeof p === 'string').join('\n');
}
export function snapshot(raw, expectedId, coverage = 'full-tree') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid conversation detail');
  const id = raw.conversation_id ?? raw.id;
  if (typeof id !== 'string' || id !== expectedId) throw new Error('Conversation ID mismatch');
  if (raw.is_truncated || raw.truncated) throw new Error('Truncated conversation response');
  const map = raw.mapping;
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('Missing raw message tree');
  const keys = Object.keys(map);
  if (!keys.length) throw new Error('Empty message tree');
  const messages = [], seenMessageIds = new Set(), parentCounts = new Map(), children = new Map();
  for (const key of keys) {
    const node = map[key];
    if (!node || typeof node !== 'object' || (node.id !== undefined && node.id !== key)) throw new Error('Invalid message tree node');
    if (node.parent != null && !Object.hasOwn(map,node.parent)) throw new Error('Incomplete message tree: missing parent');
    if (!Array.isArray(node.children ?? [])) throw new Error('Invalid message tree children');
    const edges = node.children ?? [];
    if (edges.some(child => !Object.hasOwn(map,child) || map[child].parent !== key)) throw new Error('Incomplete message tree: missing child');
    if (node.parent != null && !(map[node.parent].children ?? []).includes(key)) throw new Error('Inconsistent message tree');
    children.set(key,edges); parentCounts.set(key,node.parent == null ? 0 : 1);
    const message = node.message;
    if (!message) continue;
    if (typeof message !== 'object') throw new Error('Invalid message');
    const messageId = message.id ?? key;
    if (typeof messageId !== 'string' || seenMessageIds.has(messageId)) throw new Error('Invalid or duplicate message ID');
    seenMessageIds.add(messageId);
    messages.push({nodeId:key, messageId, role:String(message.author?.role ?? 'unknown'),
      text:plainText(message.content), json:canonical(node)});
  }
  const queue = keys.filter(k => parentCounts.get(k) === 0);
  for (let i=0;i<queue.length;i++) for (const child of children.get(queue[i])) {
    parentCounts.set(child,parentCounts.get(child)-1);
    if (parentCounts.get(child) === 0) queue.push(child);
  }
  if (queue.length !== keys.length) throw new Error('Cyclic message tree');
  if (raw.current_node != null && !Object.hasOwn(map,raw.current_node)) throw new Error('Incomplete message tree: missing current node');
  let current=raw.current_node,lastMessageId=null,lastAssistantId=null;
  while(current!=null){const message=map[current].message;if(message){lastMessageId??=message.id ?? current;
    if(message.author?.role==='assistant'){lastAssistantId=message.id ?? current;break;}}current=map[current].parent;}
  const assistantTimes=Object.values(map).filter(n=>n.message?.author?.role==='assistant').map(n=>timestamp(n.message.create_time)).filter(Boolean);
  return {id, title:String(raw.title ?? ''), updated:timestamp(raw.update_time),
    assistantUpdated:timestamp(raw.latest_assistant_turn_created_at) ?? assistantTimes.sort().at(-1) ?? null,
    lastMessageId,lastAssistantId,coverage, raw:canonical(raw), messages};
}

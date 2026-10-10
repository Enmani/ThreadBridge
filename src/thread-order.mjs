const columns={
  title:"t.title COLLATE NOCASE",
  provider:"CASE WHEN t.account LIKE '@threadbridge/claude/%' THEN 'Claude' WHEN t.account LIKE '@threadbridge/gemini/%' THEN 'Gemini' ELSE 'ChatGPT' END COLLATE NOCASE",
  scope:"COALESCE(json_extract(t.summary,'$.scope'),'') COLLATE NOCASE",
  project:"COALESCE(json_extract((SELECT value FROM meta WHERE account=t.account AND key='project_names'),'$.'||json_quote(json_extract(t.summary,'$.project'))),json_extract(t.summary,'$.project'),'') COLLATE NOCASE",
  coverage:"t.coverage COLLATE NOCASE",
  messages:"((SELECT COUNT(*) FROM messages WHERE account=t.account AND thread=t.id)+(SELECT COUNT(*) FROM browser_messages WHERE account=t.account AND thread=t.id)+(SELECT COUNT(*) FROM imported_messages WHERE account=t.account AND thread=t.id))",
  source_updated:"MAX(COALESCE(t.source_updated,''),COALESCE(t.source_assistant,''))",
  last_checked_at:"MAX(COALESCE(t.last_checked_at,''),COALESCE((SELECT updated FROM browser_archives WHERE account=t.account AND thread=t.id),''),COALESCE((SELECT updated FROM imported_archives WHERE account=t.account AND thread=t.id),''))"
};
export function threadOrder(sort='source_updated',order='desc'){
  if(!Object.hasOwn(columns,sort)||!['asc','desc'].includes(order))throw new Error('Invalid thread list parameters');
  return `${columns[sort]} ${order==='asc'?'ASC':'DESC'},t.account ASC,t.id ASC`;
}

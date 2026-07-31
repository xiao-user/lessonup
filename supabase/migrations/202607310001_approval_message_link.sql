alter table public.agent_approvals
  add column if not exists assistant_message_id uuid
  references public.agent_messages(id) on delete cascade;

update public.agent_approvals approval
set assistant_message_id = (
  select message.id
  from public.agent_messages message
  where message.owner_id = approval.owner_id
    and message.thread_id = approval.thread_id
    and message.branch_id = approval.branch_id
    and message.role = 'assistant'
    and message.created_at <= approval.created_at
  order by message.created_at desc, message.sequence desc
  limit 1
)
where approval.assistant_message_id is null;

create index if not exists agent_approvals_assistant_message
  on public.agent_approvals(owner_id, assistant_message_id);

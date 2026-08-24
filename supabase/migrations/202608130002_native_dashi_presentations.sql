-- Dashi now owns the editable deck directory and its own preview/export
-- server. Keep old self-contained artifact rows intact but never open them
-- through the native path.
alter table public.classroom_presentation_documents
  add column if not exists delivery text not null default 'legacy-static'
  check (delivery in ('legacy-static', 'native-dashi'));

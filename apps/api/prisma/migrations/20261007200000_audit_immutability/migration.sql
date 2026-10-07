-- Audit records are append-only. Updates and deletes are rejected at the
-- database level so that no application path (or normal user) can rewrite history.
-- Organization deletion is handled by the retention workflow, which uses the
-- explicit `authenq.audit_purge` session flag.
CREATE OR REPLACE FUNCTION authenq_activity_log_immutable() RETURNS trigger AS $$
BEGIN
  IF current_setting('authenq.audit_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'activity_log is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER activity_log_no_update
  BEFORE UPDATE OR DELETE ON "activity_log"
  FOR EACH ROW EXECUTE FUNCTION authenq_activity_log_immutable();

-- Trigram-free prefix search support for global search.
CREATE INDEX IF NOT EXISTS "label_projects_name_lower_idx" ON "label_projects" (lower("name"));
CREATE INDEX IF NOT EXISTS "data_sources_name_lower_idx" ON "data_sources" (lower("name"));

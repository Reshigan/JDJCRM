-- Defence in depth (security review): admin and management never belong to a department,
-- so department-scoped access can never be granted to them by setting department_id.
update users set department_id = null where role in ('admin', 'management');
alter table users add constraint users_no_dept_for_oversight check (role not in ('admin', 'management') or department_id is null);

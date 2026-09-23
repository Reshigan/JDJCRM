-- Scheduled e-mail reports (brief §7): distribution lists, editable in Admin → Settings.
insert into settings values
  ('report_daily_recipients', '[]'),
  ('report_monthly_recipients', '[]'),
  ('report_send_hour', '7')
on conflict do nothing;

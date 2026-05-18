-- Seed default agent_config rows
insert into agent_config (key, value) values
  ('system_prompt', 'You are a helpful AI assistant for Papa Bakery. You help customers with questions about the bakery, orders, and general inquiries. Be friendly, concise, and helpful.'),
  ('default_model', 'gemini-2.5-flash'),
  ('default_model:curator', 'gemini-2.5-flash'),
  ('default_model:extractor', 'gemini-2.5-flash'),
  ('default_model:skill-creator', 'gemini-2.5-flash'),
  ('memory_extraction_enabled', 'true');

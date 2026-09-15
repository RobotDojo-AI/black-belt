-- Repair passive_jobs rows created before platform integration probes were
-- routed through the owned integration_health_refresh path. These probes are
-- health checks, not durable worker types.

UPDATE passive_jobs
   SET job_type = 'integration_health_refresh',
       updated_at = datetime('now')
 WHERE unique_key IN (
   'integration:anthropic',
   'integration:google-ai',
   'integration:xai',
   'integration:ollama',
   'integration:github',
   'integration:backup',
   'integration:remote-access',
   'integration:openai'
 )
   AND job_type <> 'integration_health_refresh';

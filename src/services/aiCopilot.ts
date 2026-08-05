import http from 'http';
import https from 'https';
import { URL } from 'url';

export interface BriefingInput {
  upstream_asset_id: string;
  downstream_asset_id: string;
  dt_id: string;
  feeder_id: string;
  affected_pole_count: number;
  pincode: string | null;
  confidence: number;
  topology_source: string;
  reason: string;
  lat: number;
  lon: number;
}

export interface BriefingResult {
  briefing: string;
  source: 'LLM_GENERATED' | 'FALLBACK_TEMPLATE';
}

export function generateFallbackBriefing(input: BriefingInput): string {
  const pin = input.pincode || '560078';
  const topoTag = input.topology_source === 'explicit' ? 'Confirmed Span Topology' : 'Inferred MST Corridor';
  const confPct = Math.round(input.confidence * 100);

  return `DISPATCH BRIEFING (Deterministic Fallback): Line fault detected on segment ${input.upstream_asset_id} -> ${input.downstream_asset_id} near PIN ${pin} (${input.lat}, ${input.lon}). ${input.affected_pole_count} downstream poles dark under DT ${input.dt_id} (${topoTag}, ${confPct}% confidence). Priority field crew dispatch advised.`;
}

export async function generateDispatchBriefing(input: BriefingInput): Promise<BriefingResult> {
  const apiKey = process.env.GROQ_API_KEY || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY;

  if (!apiKey || apiKey === 'mock-key-copilot-fallback') {
    return {
      briefing: generateFallbackBriefing(input),
      source: 'FALLBACK_TEMPLATE'
    };
  }

  const prompt = `You are a SCADA dispatch assistant for Karnataka State Power Distribution Board (KSPDB).
Generate a concise 2-sentence operator dispatch briefing for the following grid fault:
- Upstream Node: ${input.upstream_asset_id}
- Downstream Node: ${input.downstream_asset_id}
- Transformer DT: ${input.dt_id} (Feeder ${input.feeder_id})
- Affected Poles: ${input.affected_pole_count}
- Coordinates: ${input.lat}, ${input.lon} (PIN: ${input.pincode || '560078'})
- Topology Confidence: ${Math.round(input.confidence * 100)}% (${input.topology_source})
Keep it professional, urgent, and concise for field crew dispatch.`;

  try {
    const responseText = await callLlmWithTimeout(apiKey, prompt, 2500);
    if (responseText && responseText.trim().length > 0) {
      return {
        briefing: responseText.trim(),
        source: 'LLM_GENERATED'
      };
    }
  } catch (err) {
    console.warn('LLM briefing generation timed out or failed, falling back to deterministic template:', (err as Error).message);
  }

  return {
    briefing: generateFallbackBriefing(input),
    source: 'FALLBACK_TEMPLATE'
  };
}

function callLlmWithTimeout(apiKey: string, prompt: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const defaultModel = process.env.GROQ_API_KEY ? 'llama-3.3-70b-versatile' : 'gpt-3.5-turbo';
    const defaultEndpoint = process.env.GROQ_API_KEY
      ? 'https://api.groq.com/openai/v1/chat/completions'
      : 'https://api.openai.com/v1/chat/completions';

    const postData = JSON.stringify({
      model: process.env.LLM_MODEL || defaultModel,
      messages: [
        { role: 'system', content: 'You are an expert power grid SCADA dispatch copilot.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 150,
      temperature: 0.3
    });

    const apiUrl = process.env.LLM_API_ENDPOINT || defaultEndpoint;
    const parsedUrl = new URL(apiUrl);
    const transport = parsedUrl.protocol === 'https:' ? https : http;

    const req = transport.request(
      apiUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: timeoutMs
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(body);
              const text = parsed.choices?.[0]?.message?.content;
              if (text) return resolve(text);
            } catch (e) {
              // ignore parse failure
            }
          }
          reject(new Error(`API responded with status code ${res.statusCode}`));
        });
      }
    );

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`LLM API request timed out after ${timeoutMs}ms`));
    });

    req.write(postData);
    req.end();
  });
}

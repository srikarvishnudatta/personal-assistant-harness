"""One explicit live Python Agents SDK call, with no personal context or tools."""
import asyncio
from .agent import AgentCapabilities, run_assistant
from .config import load_config
from .runtime import safe_error


async def main():
    config = load_config(); usage = {}
    def record(input_tokens, output_tokens): usage.update(inputTokens=input_tokens, outputTokens=output_tokens)
    print('Testing GPT-6 Luna through the Python Agents SDK (one short API call, no personal context or tools).')
    try:
        async with asyncio.timeout(45):
            result = await run_assistant(config, 'Reply with exactly MODEL_SMOKE_OK and nothing else.',
                'Connectivity test only. No personal context.', AgentCapabilities(read_only=True, max_turns=1, on_usage=record))
        assert result.strip() == 'MODEL_SMOKE_OK', 'Expected connectivity marker was not returned'
        print('Python GPT-6 Luna connection and response passed.')
        print('Reported token usage:', usage)
    except Exception as error:
        message = safe_error(error)
        for secret in (config.api_key, config.token, config.encryption_secret):
            if secret: message = message.replace(secret, '[redacted]')
        raise SystemExit('Model smoke test failed: ' + message) from None


if __name__ == '__main__': asyncio.run(main())

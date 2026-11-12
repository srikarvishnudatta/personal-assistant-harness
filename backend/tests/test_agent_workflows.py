import unittest
from datetime import datetime, timezone

from harness.agents.capabilities import AgentCapabilities
from harness.agents.tools import _build_tools
from harness.scheduling.cron import next_cron_time, next_interval_time, validate_cron
from harness.agents.workflows import research_workflow, validate_workflow, workflow_task_id


class WorkflowTests(unittest.TestCase):
    def test_default_research_graph(self):
        graph = research_workflow("Compare two options")
        self.assertEqual(graph["output"], "answer")
        self.assertEqual([node["id"] for node in graph["nodes"]],
                         ["specialist-1", "specialist-2", "verify", "answer"])
        self.assertEqual(graph["nodes"][-1]["dependsOn"], ["specialist-1", "specialist-2", "verify"])

    def test_custom_specialists_and_task_id(self):
        graph = research_workflow("Topic", [
            {"role": "A", "prompt": "Investigate A"},
            {"role": "B", "prompt": "Investigate B"},
            {"role": "C", "prompt": "Investigate C"},
        ])
        self.assertEqual(len(graph["nodes"]), 5)
        self.assertEqual(workflow_task_id("wf-123", "specialist-1"), "wf-123:specialist-1")

    def test_validation_errors(self):
        with self.assertRaisesRegex(ValueError, "cycle"):
            validate_workflow({"prompt": "x", "nodes": [
                {"id": "a", "role": "A", "prompt": "a", "dependsOn": ["b"]},
                {"id": "b", "role": "B", "prompt": "b", "dependsOn": ["a"]}], "output": "b"})
        with self.assertRaisesRegex(ValueError, "contribute"):
            validate_workflow({"prompt": "x", "nodes": [
                {"id": "a", "role": "A", "prompt": "a", "dependsOn": []},
                {"id": "b", "role": "B", "prompt": "b", "dependsOn": []}], "output": "b"})
        with self.assertRaisesRegex(ValueError, "Unknown"):
            validate_workflow({"prompt": "x", "nodes": [
                {"id": "a", "role": "A", "prompt": "a", "dependsOn": ["missing"]},
                {"id": "b", "role": "B", "prompt": "b", "dependsOn": ["a"]}], "output": "b"})


class SchedulingTests(unittest.TestCase):
    def test_cron_range_validation(self):
        validate_cron("*/15 8-17 1,15 * 1-5")
        for invalid in ("0 0 * *", "60 * * * *", "0 24 * * *", "0 0 * JAN *"):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                validate_cron(invalid)

    def test_spring_forward_skips_nonexistent_wall_time(self):
        # Toronto jumps from 01:59 to 03:00 on 2024-03-10.
        after = datetime(2024, 3, 10, 6, 0, tzinfo=timezone.utc)
        result = datetime.fromtimestamp(next_cron_time("30 2 * * *", "America/Toronto", after) / 1000,
                                        timezone.utc)
        self.assertEqual(result, datetime(2024, 3, 11, 6, 30, tzinfo=timezone.utc))

    def test_fall_back_repeated_wall_time_is_eligible_twice(self):
        after_first = datetime(2024, 11, 3, 5, 45, tzinfo=timezone.utc)
        next_run = datetime.fromtimestamp(next_cron_time("30 1 * * *", "America/Toronto", after_first) / 1000,
                                          timezone.utc)
        self.assertEqual(next_run, datetime(2024, 11, 3, 6, 30, tzinfo=timezone.utc))

    def test_interval_coalesces_missed_occurrences(self):
        self.assertEqual(next_interval_time(1_000_000, 60, 1_000_000 + 60_000 * 3 + 1), 1_000_000 + 240_000)
        with self.assertRaisesRegex(ValueError, "60 seconds"):
            next_interval_time(0, 59, 0)


class AgentAdapterTests(unittest.TestCase):
    def test_sdk_usage_details_are_compatible(self):
        from agents.usage import Usage

        # Real SDK construction caught a client schema change that mocked
        # model responses missed (required cache_write_tokens).
        usage = Usage()
        usage.add(Usage(requests=1, input_tokens=3, output_tokens=2, total_tokens=5))
        self.assertEqual((usage.input_tokens, usage.output_tokens, usage.total_tokens), (3, 2, 5))
        self.assertEqual(usage.input_tokens_details.cached_tokens, 0)
        self.assertEqual(len(usage.request_usage_entries), 1)

    def test_agent_tools_build_real_sdk_schemas(self):
        from agents import WebSearchTool, function_tool

        tools = _build_tools(AgentCapabilities(
            remember=lambda text: None, schedule=lambda prompt, run_at, interval: None,
            operate=lambda operation, args: None, web_search=True,
        ), function_tool, WebSearchTool)
        schemas = {tool.name: tool.params_json_schema for tool in tools if hasattr(tool, "params_json_schema")}
        self.assertEqual(set(schemas), {"remember", "create_schedule", "assistant_operation"})
        self.assertEqual(schemas["remember"]["properties"]["text"]["maxLength"], 2000)
        self.assertEqual(schemas["assistant_operation"]["properties"]["operation"]["enum"], [
            "browser_read", "memory_search", "goals", "files", "skills", "gmail_read",
            "calendar_read", "propose_action", "delegate", "workflow", "notify",
            "schedule_cron", "complete_goal_step", "history_search", "people_search", "provider_read",
        ])

    def test_read_only_removes_write_tools(self):
        from agents import WebSearchTool, function_tool

        tools = _build_tools(AgentCapabilities(remember=lambda text: None,
                                              schedule=lambda prompt, at, interval: None,
                                              operate=lambda operation, args: None,
                                              read_only=True, web_search=True),
                             function_tool, WebSearchTool)
        self.assertEqual(len(tools), 2)
        self.assertTrue(any(isinstance(tool, WebSearchTool) for tool in tools))
        self.assertEqual([tool.name for tool in tools if hasattr(tool, "name")],
                         ["web_search", "assistant_operation"])


if __name__ == "__main__":
    unittest.main()

import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import type { SessionRecord } from "@ludo/transcript-schema";
import type { ArtifactName, ToolName } from "@ludo/mcp-types";

interface McpDevToolsProps {
  session: SessionRecord;
}

export function McpDevTools({ session }: McpDevToolsProps) {
  const [toolName, setToolName] = useState<ToolName>("get_session_summary");
  const [input, setInput] = useState(`{\n  "sessionId": "${session.sessionId}"\n}`);
  const [output, setOutput] = useState("");
  const [isRunning, setIsRunning] = useState(false);

  const handleRunTool = async () => {
    setIsRunning(true);
    setOutput("");
    try {
      const parsedInput = JSON.parse(input);
      const result = await invoke("mcp_tool_dispatch", {
        request: {
          toolName,
          input: parsedInput,
        },
      });
      setOutput(JSON.stringify(result, null, 2));
    } catch (err) {
      setOutput(String(err));
    } finally {
      setIsRunning(false);
    }
  };

  const handleToolChange = (newTool: ToolName) => {
    setToolName(newTool);
    if (newTool === 'get_session_summary') {
        setInput(`{\n  "sessionId": "${session.sessionId}"\n}`);
    } else if (newTool === 'search_transcript') {
        setInput(`{\n  "sessionId": "${session.sessionId}",\n  "query": "release blocker"\n}`);
    } else if (newTool === 'read_artifact') {
        setInput(`{\n  "sessionId": "${session.sessionId}",\n  "artifactName": "meeting_minutes.md"\n}`);
    }
  }

  return (
    <div className="mcp-devtools">
      <h3>MCP 도구 테스트</h3>
      <div className="mcp-controls">
        <label>
          Tool
          <select value={toolName} onChange={(e) => handleToolChange(e.target.value as ToolName)}>
            <option value="get_session_summary">get_session_summary</option>
            <option value="search_transcript">search_transcript</option>
            <option value="read_artifact">read_artifact</option>
          </select>
        </label>
        <button onClick={handleRunTool} disabled={isRunning}>
          {isRunning ? "실행 중..." : "도구 실행"}
        </button>
      </div>
      <div className="mcp-io">
        <div className="mcp-panel">
          <h4>Input</h4>
          <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={8} />
        </div>
        <div className="mcp-panel">
          <h4>Output</h4>
          <pre><code>{output}</code></pre>
        </div>
      </div>
    </div>
  );
}

# PyTorch AI Assistant for VSCode

A powerful AI assistant integrated directly into Visual Studio Code to accelerate your PyTorch development. Ask questions, get code suggestions, and receive intelligent linting feedback without leaving your editor.

This extension leverages local Large Language Models (LLMs) through [Ollama](https://ollama.com/) to ensure your code remains private and accessible offline.

![feature-demo] ()

## Features

This extension offers a suite of tools designed to streamline the PyTorch development workflow.

### 🤖 AI-Powered Chat Assistant
- **Context-Aware Help**: Open a Python file and ask questions. The assistant uses the content of your active editor as context for its answers.
- **Dual-LLM Strategy**: Utilizes `Qwen` for explanations and conceptual questions, and `DeepSeek Coder` for code generation and modification tasks.
- **Interactive Code Blocks**: AI-generated code snippets come with an "Insert Code" button, allowing you to apply suggestions directly into your editor with a single click.
- **Responsive UI**: The chat interface provides loading indicators and disables input while the assistant is "thinking", ensuring a smooth user experience.

### 💡 Smart Linter & Quick Fixes
- **Static Analysis**: Automatically detects common PyTorch pitfalls, such as creating tensors without a device assignment.
- **CodeLens Actions**: Provides actionable inline suggestions (e.g., "⚡ Add .to(device)") to fix issues with a single click.

## How It Works

The extension is built on a two-part architecture:

1.  **Frontend (TypeScript/VSCode API)**: Manages all user-facing components, including the Activity Bar icon, the chat webview panel, and CodeLens providers. It acts as the bridge, sending user prompts and editor context to the backend.
2.  **Backend (Python/LangChain)**: The "brain" of the assistant. It receives requests, prepares prompts, and orchestrates interactions with the local LLMs running via Ollama.

## Requirements

1.  **VSCode**: Version 1.85.0 or newer.
2.  **Ollama**: You must have Ollama installed and running. You can download it from ollama.com.
3.  **LLMs**: Pull the required models by running the following commands in your terminal:
    ```sh
    ollama pull qwen2.5:3b
    ollama pull deepseek-coder:1.3b
    ```

## Extension Settings

This extension contributes the following settings:

*   `pytorchHelper.enableCodeLens`: Enable or disable the CodeLens-based quick fixes. (Default: `true`)

## Known Issues

*   The initial chat response can be slow depending on the performance of the local machine running the LLM.
*   The static analyzer is basic and only detects a limited set of issues.

## Release Notes

### 1.0.0

Initial release of the PyTorch AI Assistant.
- Core chat functionality with Qwen and DeepSeek Coder.
- Static analysis and CodeLens quick fixes.
- Interactive code insertion.

----


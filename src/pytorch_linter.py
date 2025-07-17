import sys
import os
import ast
from dotenv import load_dotenv
import re
import json
import tempfile
import subprocess
import traceback

# from langchain_community.llms import Ollama
from langchain_ollama import OllamaLLM
from langchain.agents import AgentExecutor, Tool, create_react_agent
from langchain.prompts import PromptTemplate
from langchain_community.utilities import WikipediaAPIWrapper

load_dotenv()

MISTRAL_API_KEY = os.getenv("MISTRAL_API_KEY")
CLAUDE_API_KEY = os.getenv("CLAUDE_API_KEY") # Placeholder for future use

class PyTorchAssistant:
    def __init__(self):
        # Initialize with updated Ollama import
        # [https://python.langchain.com/api_reference/ollama/llms/langchain_ollama.llms.OllamaLLM.html]

        # Upgrades while keeping models small
        self.orchestrator = OllamaLLM(model="qwen3:1.7b", reasoning=True)
        self.coder = OllamaLLM(model="deepseek-r1:1.5b", reasoning=True)
        # self.critic = OllamaLLM(model="qwen3:1.7b", reasoning=True)

        self.search_tool = Tool(
            name="Wikipedia Search",
            func=self.search_wikipedia,
            description="Search Wikipedia for useful general knowledge"
        )
        
        self.code_tool = Tool(
            name="DeepSeek Coder",
            func=self.generate_code,
            description="Generate and modify code based on user requests and context"
        )

        self.test_code_tool = Tool(
            name="Test Code",
            func=self.test_code_func,
            description="Test python code to check for errors and verify its output against an expected result. Input should be a JSON string with 'code' and 'expected_output' keys. The 'code' should be a complete runnable script. The 'expected_output' should be the exact string the script is expected to print to stdout."
        )

        # self.code_review = Tool(
        #     name="Code Review",
        #     func= _________,
        #     description="Review code to check underlying logic and goal alignment with user requests"
        #)

        # self.break_down_code = Tool(
        #     name="Break Down Code",
        #     func= _________,
        #     description="Break down code to understand underlying logic and goals"
        #)

        # self.review_prd = Tool(
        #     name="Review PRD",
        #     func= _________,
        #     description="Review PRD to understand project requirements, goals, and rules"
        # )

        # self.knowledge_graph_tool = Tool(
        #     name="Knowledge Graph",
        #     func= _________,
        #     description="Search Knowledge Graph for useful documentation"
        # )

        # MCP integration here? - if we go with cloud connection

        self.agent = self.create_agent()

    def create_agent(self):
        """Create agent with proper prompt template including tool_names"""
        tools = [self.search_tool, self.code_tool, self.test_code_tool]
        
        prompt_template = PromptTemplate.from_template("""
        You are PyTorchMaster, an expert AI assistant for PyTorch development.
        When writing or modifying code, you should test it with the `test_code` tool to ensure it works correctly before providing the final answer.
        Use these tools when needed:
        {tools}
        
        Tools:
        {tool_names}
        
        Follow this format:
        Question: the input question
        Thought: I need to write some code. I should also think about how to test it to verify the result.
        Action: the action to take (one of: {tool_names})
        Action Input: the input to the action
        Observation: the result of the action
        Thought: I can now test the generated code. I'll write a simple test case.
        Action: test_code
        Action Input: {{"code": "import torch\\n\\n# ... code to test ...\\n\\nprint(result)", "expected_output": "expected result"}}
        Observation: The test passed/failed.
        ... (if the test fails, repeat the cycle of Thought, Action (DeepSeek Coder), Observation, Action (test_code), Observation until the test passes)
        Thought: I now know the final answer
        Final Answer: the final answer
        
        Current conversation:
        {history}
        
        Question: {input}
        Thought: {agent_scratchpad}
        """)
        
        return create_react_agent(
            llm=self.orchestrator,
            tools=tools,
            prompt=prompt_template.partial(
                tool_names=", ".join([t.name for t in tools])
            )
        )

    def search_wikipedia(self, query: str) -> str:
        """Search Wikipedia (placeholder - integrate KG later)"""
        wikipedia = WikipediaAPIWrapper()
        return wikipedia.run(f"{query}") 
    
    def refine_prompt(self, user_input: str, code: str) -> str:
        prompt = f"""
        Refine this PyTorch request for the coding assistant:
        Original: {user_input}
        Code Context: {code}
        Output format:
        REFINED_REQUEST: Clear technical specification
        CONTEXT_NOTES: Relevant implementation details"""
        return self.orchestrator.invoke(prompt)
    
    def generate_code(self, refined_prompt: str, code: str) -> str:
        # Updated prompt to request the full, modified file content
        prompt = f"""You are an expert Python and PyTorch programmer. Your task is to modify the user's code based on their request.

### Task Specification:
{refined_prompt}

### Full Original Code:
```python
{code}
```

### Instructions:
- Respond with the *entire* modified Python file content.
- Do NOT add any explanations, introductory text, or summaries.
- Your entire response should be a single Python code block.
- Example: ```python\\n# all the modified code here...\\n```
- If no changes are needed, return the original code.
"""
        return self.coder.invoke(prompt)
    
    def test_code_func(self, input_str: str) -> str:
        """
        Tests Python code by executing it in a temporary file and comparing its stdout to an expected output.
        The input must be a JSON string containing 'code' and 'expected_output'.
        """
        try:
            data = json.loads(input_str)
            code_to_test = data.get("code")
            expected_output = data.get("expected_output")

            if code_to_test is None:
                return "Error: 'code' key not found in input JSON."

        except json.JSONDecodeError:
            return "Error: Invalid JSON input. Please provide a JSON string with 'code' and 'expected_output' keys."
        except Exception as e:
            return f"Error parsing input: {str(e)}"

        # Create a temporary file to write the code to
        try:
            with tempfile.NamedTemporaryFile(mode='w+', suffix='.py', delete=False) as temp_file:
                temp_file.write(code_to_test)
                temp_file_path = temp_file.name
            
            # Execute the code in the temporary file
            result = subprocess.run(
                [sys.executable, temp_file_path],
                capture_output=True,
                text=True,
                timeout=15  # Set a timeout to prevent long-running code
            )

            if result.returncode != 0:
                return f"Execution failed with error:\n{result.stderr}"

            actual_output = result.stdout.strip()
            
            if expected_output is not None:
                if actual_output == expected_output.strip():
                    return "Test Passed: The code ran successfully and the output matches the expected result."
                else:
                    return f"Test Failed: Output did not match expected result.\nExpected:\n---\n{expected_output.strip()}\n---\n\nActual:\n---\n{actual_output}\n---"
            else:
                # If no expected output is provided, just confirm successful execution
                return f"Code executed successfully without errors.\nOutput:\n{actual_output}"

        except Exception as e:
            return f"An unexpected error occurred during testing: {str(e)}"
        finally:
            # Ensure the temporary file is deleted
            if 'temp_file_path' in locals() and os.path.exists(temp_file_path):
                os.remove(temp_file_path)

    def extract_code_blocks(self, response: str) -> str:
        # Expect a single code block with the full file content
        match = re.search(r'```(?:python\n)?(.*)```', response, re.DOTALL)
        if match:
            return match.group(1).strip()
        # Fallback if the model doesn't use a code block
        return response.strip()

    def handle_chat_request(self, user_input: str, files: list) -> str:
        try:
            # Construct a single string with all file contexts
            code_context_parts = []
            for file_info in files:
                file_path = file_info.get('filePath', 'unknown_file')
                content = file_info.get('content', '')
                # Using a clear separator for the LLM
                code_context_parts.append(f"### FILE: {file_path} ###\n\n```python\n{content}\n```")
            
            code_context = "\n\n---\n\n".join(code_context_parts)

            # Unified prompt for both explanation and code generation
            prompt = f"""
You are an expert Python and PyTorch programmer providing an explanation.

You can use the DeepSeek code tool to generate code changes.
### User Request:
{user_input}

### Code Context:
{code_context}

### Instructions:
1.  Provide a clear and detailed explanation that answers the user's request. Use markdown for formatting.
2.  Use the search tool to find any relevant documentation for this request.
2.  Include small, illustrative code snippets in your explanation where necessary, using ````python` blocks.
3.  **If your explanation suggests specific changes to the user's code, provide the complete, modified code for each changed file at the end of your response. Each file's content must be inside a separate code block, marked with ````python:apply:path/to/your/file.py`.**
4.  If only one file is changed, use one block. If multiple files are changed, use multiple blocks.
5.  If no changes are suggested, do not include any ````python:apply` blocks.
"""
            response_text = self.orchestrator.invoke(prompt)

            # New logic to find all apply blocks with file paths
            apply_pattern = r'```python:apply:(.*?)\n(.*?)\n```'
            matches = re.finditer(apply_pattern, response_text, re.DOTALL)
            
            changes = []
            for match in matches:
                file_path = match.group(1).strip()
                new_content = match.group(2).strip()
                if file_path and new_content:
                    changes.append({"filePath": file_path, "newContent": new_content})

            if changes:
                explanation_text = re.sub(apply_pattern, '', response_text, flags=re.DOTALL).strip()
                return  json.dumps({
                    "type": "multi_file_change",
                    "explanation": explanation_text,
                    "changes": changes,
                })
            else:
                return json.dumps({"type": "explanation", "content": response_text})

        except Exception as e:
            return json.dumps({"type": "error", "content": f"An error occurred: {str(e)}"})


class CodeAnalyzer(ast.NodeVisitor):
    def __init__(self):
        self.issues = []
        self.device_operations = {'cuda', 'to', 'cpu'}
    
    def visit_Assign(self, node):
        if isinstance(node.value, ast.Call):
            if hasattr(node.value.func, 'attr') and node.value.func.attr == 'Tensor':
                if not self._has_device_operation(node):
                    target_name = node.targets[0].id if node.targets else "tensor"
                    self.issues.append({
                        'line': node.lineno,
                        'message': 'Tensor created without device assignment',
                        'fix': f"{target_name}.to(device)"
                    })                
    
    def visit_Call(self, node):
        if isinstance(node.func, ast.Attribute) and \
           node.func.attr == 'backward' and \
           not any(kw.arg == 'retain_graph' for kw in node.keywords):
            self.issues.append({
                'line': node.lineno,
                'message': 'Missing retain_graph in backward()',
                'fix': 'retain_graph=True'
            })        
        self.generic_visit(node)
    
    def _has_device_operation(self, node):
        for parent in ast.walk(node):
            if isinstance(parent, ast.Call) and hasattr(parent.func, 'attr'):
                if parent.func.attr in self.device_operations:
                    return True
        return False


def analyze_file(file_path: str) -> str:
    with open(file_path, 'r') as f:
        code = f.read()
    
    tree = ast.parse(code)
    analyzer = CodeAnalyzer()
    analyzer.visit(tree)
    
    if analyzer.issues:
        return "\n".join(
            f"Line {issue['line']}: {issue['message']}: {issue['fix']}"
            for issue in analyzer.issues
        )
    return "No PyTorch issues found"


# Initialize assistant with error handling
try:
    assistant = PyTorchAssistant()
except Exception as e:
    print(f"Failed to initialize PyTorchAssistant: {str(e)}")
    assistant = None

def handle_chat_request(user_input: str, files: list, model: str = "local") -> str:
    """Main entry point with error handling"""
    if not assistant:
        return json.dumps({"type": "error", "content": "Assistant initialization failed"})
    
    if model == "local":
        return assistant.handle_chat_request(user_input, files)
    elif model == "codestral":
        if not MISTRAL_API_KEY:
            return json.dumps({"type": "error", "content": "MISTRAL_API_KEY not found in .env file. Please add it to use Codestral."})
        try:
            from langchain_mistralai import ChatMistralAI

            llm = ChatMistralAI(
                model="codestral-latest",
                endpoint="https://codestral.mistral.ai/v1",
                api_key=MISTRAL_API_KEY,
                temperature=0.0,
                max_retries=2,
            )

            prompt = f"""You are an expert Python and PyTorch programmer.\n ### User Request: \n{user_input}"""

            response_text = llm.invoke(prompt).content
            return json.dumps({"type": "explanation", "content": response_text})

        except Exception as e:
            traceback_str = ''.join(traceback.format_exception(None, e, e.__traceback__))
            return json.dumps({"type": "error", "content": f"Error during Codestral API call: {str(e)} \n Traceback: {traceback_str}"})

    elif model == "claude":
        # TODO: Implement Claude call
        return json.dumps({"type": "explanation", "content": f"Claude Sonnet 4 API support is not implemented yet."})
    else:
        return json.dumps({"type": "error", "content": f"Unknown model selected: {model}"})

if __name__ == '__main__':
    # This script now reads from stdin for chat requests
    # The static analysis part can be triggered by a different command if needed
    for line in sys.stdin:
        try:
            data = json.loads(line)
            if data.get("command") == "chat":
                prompt = data.get("prompt", "")
                files = data.get("files", [])
                model = data.get("model", "local")
                response = handle_chat_request(prompt, files, model)
                # The response is already a JSON string, so we just print it
                print(response)
                sys.stdout.flush()
        except json.JSONDecodeError:
            print(json.dumps({"type": "error", "content": "Invalid JSON from extension."}))
            sys.stdout.flush()
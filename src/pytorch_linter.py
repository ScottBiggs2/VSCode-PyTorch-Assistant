import sys
import ast
import re
import json
from langchain_community.llms import Ollama
from langchain.agents import AgentExecutor, Tool, create_react_agent
from langchain.prompts import PromptTemplate
from langchain_community.utilities import WikipediaAPIWrapper

class PyTorchAssistant:
    def __init__(self):
        # Initialize with updated Ollama import
        self.orchestrator = Ollama(model="qwen2.5:3b")
        self.coder = Ollama(model="deepseek-coder:1.3B")
        self.search_tool = Tool(
            name="PyTorch Documentation Search",
            func=self.search_docs,
            description="Search PyTorch documentation for API references and best practices"
        )
        self.agent = self.create_agent()

    def create_agent(self):
        """Create agent with proper prompt template including tool_names"""
        tools = [self.search_tool]
        
        prompt_template = PromptTemplate.from_template("""
        You are PyTorchMaster, an expert AI assistant for PyTorch development.
        Use these tools when needed:
        {tools}
        
        Tools:
        {tool_names}
        
        Follow this format:
        Question: the input question
        Thought: think about what to do
        Action: the action to take (one of: {tool_names})
        Action Input: the input to the action
        Observation: the result of the action
        ... (repeat as needed)
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

    def search_docs(self, query: str) -> str:
        """Search PyTorch documentation (placeholder - integrate KG later)"""
        wikipedia = WikipediaAPIWrapper()
        return wikipedia.run(f"PyTorch {query}")
    
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
    
    def extract_code_blocks(self, response: str) -> str:
        # Expect a single code block with the full file content
        match = re.search(r'```(?:python\n)?(.*)```', response, re.DOTALL)
        if match:
            return match.group(1).strip()
        # Fallback if the model doesn't use a code block
        return response.strip()

    def handle_chat_request(self, user_input: str, code: str) -> str:
        try:
            # Unified prompt for both explanation and code generation
            prompt = f"""
You are an expert Python and PyTorch programmer providing an explanation.

### User Request:
{user_input}

### Code Context:
```python
{code}
```

### Instructions:
1.  Provide a clear and detailed explanation that answers the user's request. Use markdown for formatting.
2.  Include small, illustrative code snippets in your explanation where necessary, using ```python blocks.
3.  **If your explanation suggests specific changes to the user's code (modifications, additions, or deletions), then at the very end of your response, provide the complete, modified code for the entire file inside a single, final code block marked with ```python:apply`.**
4.  If no changes are suggested, do not include a final ```python:apply` block.
"""
            response_text = self.orchestrator.invoke(prompt)

            # Check for the special apply block
            apply_match = re.search(r'```python:apply\n(.*?)\n```', response_text, re.DOTALL)

            if apply_match:
                full_code_changes = apply_match.group(1).strip()
                # Remove the apply block from the main explanation text for a cleaner display
                explanation_text = re.sub(r'```python:apply\n(.*?)\n```', '', response_text, flags=re.DOTALL).strip()
                return json.dumps({
                    "type": "explanation_with_changes",
                    "explanation": explanation_text,
                    "code": full_code_changes
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

def handle_chat_request(user_input: str, code: str) -> str:
    """Main entry point with error handling"""
    if not assistant:
        return json.dumps({"type": "error", "content": "Assistant initialization failed"})
    
    # The handle_chat_request now includes its own try/except and returns JSON
    return assistant.handle_chat_request(user_input, code)

if __name__ == '__main__':
    # This script now reads from stdin for chat requests
    # The static analysis part can be triggered by a different command if needed
    for line in sys.stdin:
        try:
            data = json.loads(line)
            if data.get("command") == "chat":
                prompt = data.get("prompt", "")
                code = data.get("code", "")
                response = handle_chat_request(prompt, code)
                # The response is already a JSON string, so we just print it
                print(response)
                sys.stdout.flush()
        except json.JSONDecodeError:
            print(json.dumps({"type": "error", "content": "Invalid JSON from extension."}))
            sys.stdout.flush()
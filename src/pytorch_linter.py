import sys
import ast
import re
import json
# from langchain_community.llms import Ollama
from langchain_ollama import OllamaLLM
from langchain.agents import AgentExecutor, Tool, create_react_agent
from langchain.prompts import PromptTemplate
from langchain_community.utilities import WikipediaAPIWrapper

class PyTorchAssistant:
    def __init__(self):
        # Initialize with updated Ollama import

        # to-do: update LLMs and set reasoning = True 
        # [https://python.langchain.com/api_reference/ollama/llms/langchain_ollama.llms.OllamaLLM.html]
        
        # self.orchestrator = Ollama(model="qwen2.5:3b")
        # self.coder = Ollama(model="deepseek-coder:1.3B")

        # Upgrades while keeping models small
        self.orchestrator = OllamaLLM(model="qwen3:1.7b", reasoning=False)
        self.coder = OllamaLLM(model="deepseek-r1:1.5b", reasoning=True)

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

### User Request:
{user_input}

### Code Context:
{code_context}

### Instructions:
1.  Provide a clear and detailed explanation that answers the user's request. Use markdown for formatting.
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
                return json.dumps({
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

def handle_chat_request(user_input: str, files: list) -> str:
    """Main entry point with error handling"""
    if not assistant:
        return json.dumps({"type": "error", "content": "Assistant initialization failed"})
    

    return assistant.handle_chat_request(user_input, files)

if __name__ == '__main__':
    # This script now reads from stdin for chat requests
    # The static analysis part can be triggered by a different command if needed
    for line in sys.stdin:
        try:
            data = json.loads(line)
            if data.get("command") == "chat":
                prompt = data.get("prompt", "")
                files = data.get("files", [])
                response = handle_chat_request(prompt, files)
                # The response is already a JSON string, so we just print it
                print(response)
                sys.stdout.flush()
        except json.JSONDecodeError:
            print(json.dumps({"type": "error", "content": "Invalid JSON from extension."}))
            sys.stdout.flush()
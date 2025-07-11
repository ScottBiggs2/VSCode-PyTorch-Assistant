import sys
import ast
import re
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
        prompt = f"""
        ### Task Specification:
        {refined_prompt}
        ### Code Context:
        {code}
        ### Guidelines:
        1. Generate minimal, runnable PyTorch code
        2. Preserve existing style
        3. Use ```python blocks
        4. Add brief comments only for complex logic"""
        return self.coder.invoke(prompt)
    
    def extract_code_blocks(self, response: str) -> str:
        code_blocks = re.findall(r'```python\n(.*?)\n```', response, re.DOTALL)
        return "\n\n".join(code_blocks) if code_blocks else response

    def handle_chat_request(self, user_input: str, code: str) -> str:
        try:
            # Step 1: Determine request type
            plan = self.orchestrator.invoke(
                f"Classify this PyTorch request: '{user_input}'. "
                "Respond with either 'EXPLANATION' or 'CODE_GENERATION'"
            )
            
            if "EXPLANATION" in plan:
                return self.orchestrator.invoke(
                    f"Explain: {user_input}\nCode context: {code}\n"
                    "Provide detailed explanations with examples."
                )
            
            # Step 2: Refine and process code requests
            refined = self.refine_prompt(user_input, code)
            
            if any(kw in user_input.lower() for kw in ['research', 'docs']):
                return AgentExecutor(
                    agent=self.agent,
                    tools=[self.search_tool],
                    verbose=True
                ).invoke({
                    "input": refined,
                    "history": f"Code context: {code}"
                })["output"]
            
            response = self.generate_code(refined, code)
            return self.extract_code_blocks(response)
            
        except Exception as e:
            return f"❌ Error processing request: {str(e)}"

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
        return "❌ Assistant initialization failed"
    
    try:
        return assistant.handle_chat_request(user_input, code)
    except Exception as e:
        return f"❌ Error processing request: {str(e)}"
    

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Error: Missing file path argument")
        sys.exit(1)
        
    with open(sys.argv[1], 'r') as f:
        code = f.read()
    
    if '--chat' in sys.argv:
        chat_index = sys.argv.index('--chat')
        if len(sys.argv) > chat_index + 1:
            prompt = sys.argv[chat_index + 1]
            print(handle_chat_request(prompt, code))
        else:
            print("Error: --chat flag requires a prompt argument.")
            sys.exit(1)
    else:
        print(analyze_file(sys.argv[1]))
import sys
import ast
from langchain_community.llms import Ollama

class CodeAnalyzer(ast.NodeVisitor):
    def __init__(self):
        self.issues = []
        self.device_operations = {'cuda', 'to', 'cpu'}
    
    def visit_Assign(self, node):
        if isinstance(node.value, ast.Call):
            # Detect tensor creation without device
            if hasattr(node.value.func, 'attr') and node.value.func.attr == 'Tensor':
                if not self._has_device_operation(node):
                    target_name = node.targets[0].id if node.targets else "tensor"
                    self.issues.append({
                        'line': node.lineno,
                        'message': 'Tensor created without device assignment',
                        'fix': f"{target_name}.to(device)"
                    })
    
    def visit_Call(self, node):
        # Detect missing retain_graph
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
        """Check if tensor has any device-related operations"""
        for parent in ast.walk(node):
            if isinstance(parent, ast.Call) and hasattr(parent.func, 'attr'):
                if parent.func.attr in self.device_operations:
                    return True
        return False

def handle_chat_request(user_input: str, code: str) -> str:
    try:
        # Determine if we should use Qwen or DeepSeek
        use_qwen = any(keyword in user_input.lower() for keyword in 
                      ['explain', 'why', 'what', 'how', 'should', '?'])
        
        model = "qwen2.5:3b" if use_qwen else "deepseek-coder:1.3B"
        llm = Ollama(model=model)
        
        # System prompt for Qwen (explanations)
        if use_qwen:
            system_prompt = f"""### Role: PyTorch Expert Assistant
### Task: Provide detailed explanation
### User Question: {user_input}
### Code Context:
{code}

### Response Guidelines:
1. Break down complex concepts
2. Compare alternatives
3. Provide best practices
4. Use bullet points for clarity"""
            return llm.invoke(system_prompt)
        
        # System prompt for DeepSeek (code generation)
        system_prompt = f"""### Role: PyTorch Coding Assistant
### Task: Generate code for request
### User Request: {user_input}
### Code Context:
{code}

### Response Guidelines:
1. Return complete, runnable code blocks
2. Wrap code in triple backticks
3. Include comments for key steps
4. Maintain existing code style"""
        return llm.invoke(system_prompt)
    
    except Exception as e:
        return f"❌ Error processing request: {str(e)}"


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

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Error: Missing file path argument")
        sys.exit(1)
        
    with open(sys.argv[1], 'r') as f:
        code = f.read()
    
    # Handle chat requests
    if '--chat' in sys.argv:
        chat_index = sys.argv.index('--chat')
        if len(sys.argv) > chat_index + 1:
            prompt = sys.argv[chat_index + 1]
            print(handle_chat_request(prompt, code))
        else:
            print("Error: --chat flag requires a prompt argument.")
            sys.exit(1)
    # Handle static analysis
    else:
        print(analyze_file(sys.argv[1]))
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
            if (isinstance(node.value.func, ast.Attribute) and node.value.func.attr == 'Tensor'):
                if not self._has_device_operation(node):
                    self.issues.append({
                        'line': node.lineno,
                        'message': 'Tensor created without device assignment',
                        'fix': f"{node.targets[0].id}.to(device)" if node.targets else "tensor.to(device)"
                    })
    
    def visit_Call(self, node):
        # Detect missing retain_graph
        if (isinstance(node.func, ast.Attribute) and 
            node.func.attr == 'backward' and
            not any(kw.arg == 'retain_graph' for kw in node.keywords)):
            self.issues.append({
                'line': node.lineno,
                'message': 'Missing retain_graph in backward()',
                'fix': 'backward(retain_graph=True)'
            })
        self.generic_visit(node)
    
    def _has_device_operation(self, node):
        """Check if tensor has any device-related operations"""
        for parent in ast.walk(node):
            if (isinstance(parent, ast.Call) and hasattr(parent.func, 'attr')):
                if parent.func.attr in self.device_operations:
                    return True
        return False

def analyze_with_llm(code: str, prompt: str = None):
    llm = Ollama(model="deepseek-coder")
    
    if prompt:  # Chat mode
        system_prompt = f"""You are a PyTorch expert. For this request:
{prompt}

Provide specific code changes in this format:
Line X: [description]: [new code]
Line Y: [description]: [new code]"""
        return llm.invoke(f"{system_prompt}\n\nCode:\n{code}")
    
    else:  # Static analysis mode
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
    with open(sys.argv[1], 'r') as f:
        code = f.read()
    
    if len(sys.argv) > 2 and sys.argv[2] == '--chat':
        prompt = ' '.join(sys.argv[3:])
        print(analyze_with_llm(code, prompt))
    else:
        print(analyze_with_llm(code))
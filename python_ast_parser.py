import ast
import json
import sys
import os

class CorrdexVisitor(ast.NodeVisitor):
    def __init__(self):
        self.metadata = {
            "imports": [],
            "importSources": [],
            "importedSymbols": [],
            "callExpressions": [],
            "propertyAccessExpressions": [],
            "memberExpressions": [],
            "catchClauses": [],
            "exports": [],
            "executionBlocks": [],
            "classDeclarations": [],
            "decorators": [],
            "ifStatementCount": 0,
            "loopCount": 0,
            "hasAsyncAwait": False
        }
        self.block_stack = []
        self.class_stack = []

    def _normalize_stable_segment(self, value):
        cleaned = "".join(ch if ch.isalnum() else "-" for ch in value.strip().lower())
        while "--" in cleaned:
            cleaned = cleaned.replace("--", "-")
        return cleaned.strip("-")

    def _build_stable_block_id(self, kind, name, enclosing_class_name, start_line, end_line):
        parts = [kind]
        if enclosing_class_name:
            normalized_class = self._normalize_stable_segment(enclosing_class_name)
            if normalized_class:
                parts.append(f"class-{normalized_class}")

        if name:
            normalized_name = self._normalize_stable_segment(name)
            if normalized_name:
                parts.append(f"name-{normalized_name}")
            else:
                parts.append(f"lines-{start_line}-{end_line}")
        else:
            parts.append(f"lines-{start_line}-{end_line}")

        base_id = ":".join(parts)
        candidate = base_id
        duplicate_count = 2
        existing_ids = {block.get("stableId") for block in self.metadata["executionBlocks"]}

        while candidate in existing_ids:
            candidate = f"{base_id}#{duplicate_count}"
            duplicate_count += 1

        return candidate

    def get_line_col(self, node):
        return getattr(node, 'lineno', 0), getattr(node, 'col_offset', 0)

    def visit_Import(self, node):
        line, col = self.get_line_col(node)
        for alias in node.names:
            self.metadata["importSources"].append({
                "moduleSpecifier": alias.name,
                "line": line,
                "column": col
            })
            self.metadata["importedSymbols"].append({
                "localName": alias.asname if alias.asname else alias.name,
                "importedName": alias.name,
                "moduleSpecifier": alias.name,
                "line": line,
                "column": col
            })
        self.generic_visit(node)

    def visit_ImportFrom(self, node):
        line, col = self.get_line_col(node)
        module_name = node.module if node.module else ""
        if module_name:
            self.metadata["importSources"].append({
                "moduleSpecifier": module_name,
                "line": line,
                "column": col
            })
        for alias in node.names:
            self.metadata["importedSymbols"].append({
                "localName": alias.asname if alias.asname else alias.name,
                "importedName": alias.name,
                "moduleSpecifier": module_name,
                "line": line,
                "column": col
            })
        self.generic_visit(node)

    def visit_Call(self, node):
        line, col = self.get_line_col(node)
        block_id = self.block_stack[-1] if self.block_stack else None
        
        # Best effort expression extraction
        expression_str = ""
        if isinstance(node.func, ast.Name):
            expression_str = node.func.id
        elif isinstance(node.func, ast.Attribute):
            val = ""
            if isinstance(node.func.value, ast.Name):
                val = node.func.value.id
            expression_str = f"{val}.{node.func.attr}" if val else node.func.attr
        
        # Simple argument extraction
        arguments = []
        for arg in node.args:
            if isinstance(arg, ast.Constant):
                arguments.append(str(arg.value))
            elif isinstance(arg, ast.Name):
                arguments.append(arg.id)
            else:
                arguments.append("<complex>")
        
        for kw in node.keywords:
            if isinstance(kw.value, ast.Constant):
                arguments.append(f"{kw.arg}={kw.value.value}")
            elif isinstance(kw.value, ast.Name):
                arguments.append(f"{kw.arg}={kw.value.id}")
            else:
                arguments.append(f"{kw.arg}=<complex>")
        
        self.metadata["callExpressions"].append({
            "expression": expression_str,
            "arguments": arguments,
            "line": line,
            "column": col,
            "blockId": block_id,
            "context": {"type": "unknown", "semanticName": ""}
        })
        
        if isinstance(node.func, ast.Attribute):
            self.metadata["memberExpressions"].append({
                "object": expression_str.split('.')[0] if '.' in expression_str else "",
                "property": node.func.attr,
                "expression": expression_str,
                "usage": "call-target",
                "line": line,
                "column": col,
                "blockId": block_id,
                "context": {"type": "unknown", "semanticName": ""}
            })
            
        self.generic_visit(node)

    def visit_Attribute(self, node):
        line, col = self.get_line_col(node)
        block_id = self.block_stack[-1] if self.block_stack else None
        obj_name = ""
        if isinstance(node.value, ast.Name):
            obj_name = node.value.id
            
        expr_str = f"{obj_name}.{node.attr}" if obj_name else node.attr
        
        self.metadata["propertyAccessExpressions"].append({
            "expression": expr_str,
            "line": line,
            "column": col,
            "blockId": block_id,
            "context": {"type": "unknown", "semanticName": ""}
        })
        self.generic_visit(node)

    def visit_ExceptHandler(self, node):
        line, col = self.get_line_col(node)
        block_id = self.block_stack[-1] if self.block_stack else None
        self.metadata["catchClauses"].append({
            "line": line,
            "column": col,
            "blockId": block_id
        })
        self.generic_visit(node)

    def visit_Raise(self, node):
        line, col = self.get_line_col(node)
        block_id = self.block_stack[-1] if self.block_stack else None
        
        # In Corrdex, throws are treated as callExpressions to "throw" or the exception name
        exception_name = "Exception"
        if node.exc:
            if isinstance(node.exc, ast.Name):
                exception_name = node.exc.id
            elif isinstance(node.exc, ast.Call):
                if isinstance(node.exc.func, ast.Name):
                    exception_name = node.exc.func.id
                elif isinstance(node.exc.func, ast.Attribute):
                    exception_name = node.exc.func.attr
                    
        self.metadata["callExpressions"].append({
            "expression": exception_name,
            "arguments": [],
            "line": line,
            "column": col,
            "blockId": block_id,
            "context": {"type": "unknown", "semanticName": ""}
        })
        
        self.generic_visit(node)

    def visit_If(self, node):
        self.metadata["ifStatementCount"] += 1
        self.generic_visit(node)

    def visit_IfExp(self, node):
        self.metadata["ifStatementCount"] += 1
        self.generic_visit(node)

    def visit_For(self, node):
        self.metadata["loopCount"] += 1
        self.generic_visit(node)
        
    def visit_AsyncFor(self, node):
        self.metadata["loopCount"] += 1
        self.metadata["hasAsyncAwait"] = True
        self.generic_visit(node)

    def visit_While(self, node):
        self.metadata["loopCount"] += 1
        self.generic_visit(node)
        
    def visit_Await(self, node):
        self.metadata["hasAsyncAwait"] = True
        self.generic_visit(node)

    def _process_decorators(self, decorator_list):
        for dec in decorator_list:
            if isinstance(dec, ast.Name):
                self.metadata["decorators"].append("@" + dec.id)
            elif isinstance(dec, ast.Attribute):
                if isinstance(dec.value, ast.Name):
                    self.metadata["decorators"].append("@" + dec.value.id + "." + dec.attr)
                else:
                    self.metadata["decorators"].append("@" + dec.attr)
            elif isinstance(dec, ast.Call):
                if isinstance(dec.func, ast.Name):
                    self.metadata["decorators"].append("@" + dec.func.id)
                elif isinstance(dec.func, ast.Attribute):
                    if isinstance(dec.func.value, ast.Name):
                        self.metadata["decorators"].append("@" + dec.func.value.id + "." + dec.func.attr)
                    else:
                        self.metadata["decorators"].append("@" + dec.func.attr)

    def visit_FunctionDef(self, node):
        self._handle_function(node, "function")

    def visit_AsyncFunctionDef(self, node):
        self.metadata["hasAsyncAwait"] = True
        self._handle_function(node, "function")

    def _handle_function(self, node, kind):
        line, col = self.get_line_col(node)
        block_id = f"fn_{len(self.metadata['executionBlocks']) + 1}"
        enclosing_class_name = self.class_stack[-1]["name"] if self.class_stack else None
        stable_id = self._build_stable_block_id(kind, node.name, enclosing_class_name, line, getattr(node, 'end_lineno', line))
        is_module_scope = not self.block_stack and not self.class_stack
        self.block_stack.append(block_id)

        self._process_decorators(node.decorator_list)

        if is_module_scope:
            self.metadata["exports"].append({
                "kind": "function",
                "name": node.name,
                "isDefault": False,
                "line": line,
                "column": col
            })
        
        # Very basic dependencies/identifiers extraction
        identifiers = []
        for child in ast.walk(node):
            if isinstance(child, ast.Name):
                identifiers.append(child.id)
            elif isinstance(child, ast.Attribute):
                identifiers.append(child.attr)
                
        # deduplicate
        identifiers = list(set(identifiers))
        
        self.metadata["executionBlocks"].append({
            "id": block_id,
            "stableId": stable_id,
            "name": node.name,
            "kind": kind,
            "startLine": line,
            "endLine": getattr(node, 'end_lineno', line),
            "dependencies": [], # Complex to resolve reliably in Python without type hints
            "identifiers": identifiers,
            "parameterNames": [arg.arg for arg in node.args.args],
            "ifStatementCount": 0,
            "loopCount": 0,
            "hasAsyncAwait": isinstance(node, ast.AsyncFunctionDef),
            "isExported": is_module_scope,
            "enclosingClassName": enclosing_class_name,
        })
        
        self.generic_visit(node)
        self.block_stack.pop()

    def visit_ClassDef(self, node):
        line, col = self.get_line_col(node)
        is_module_scope = not self.block_stack and not self.class_stack
        self._process_decorators(node.decorator_list)

        def _base_name(base):
            if isinstance(base, ast.Name):
                return base.id
            if isinstance(base, ast.Attribute):
                if isinstance(base.value, ast.Name):
                    return base.value.id + "." + base.attr
                return base.attr
            if isinstance(base, ast.Subscript):
                if isinstance(base.value, ast.Name):
                    return base.value.id
                if isinstance(base.value, ast.Attribute):
                    if isinstance(base.value.value, ast.Name):
                        return base.value.value.id + "." + base.value.attr
                    return base.value.attr
            return ""

        super_class = ""
        if node.bases:
            base_names = [_base_name(base) for base in node.bases]
            base_names = [name for name in base_names if name]
            if base_names:
                super_class = ",".join(base_names)
            
        self.metadata["classDeclarations"].append({
            "name": node.name,
            "superClass": super_class,
            "line": line,
            "column": col
        })

        if is_module_scope:
            self.metadata["exports"].append({
                "kind": "class",
                "name": node.name,
                "isDefault": False,
                "line": line,
                "column": col
            })

        # Treat methods as execution blocks
        self.class_stack.append({
            "name": node.name,
            "startLine": line,
            "endLine": getattr(node, "end_lineno", line),
        })
        for body_node in node.body:
            if isinstance(body_node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self._handle_function(body_node, "method")
                
        # Visit everything else in the class
        for body_node in node.body:
            if not isinstance(body_node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self.visit(body_node)
        self.class_stack.pop()

    def _record_module_level_assignment_export(self, target, value, line, col):
        if not isinstance(target, ast.Name):
            return

        export_kind = "variable"
        if isinstance(value, (ast.Dict, ast.List, ast.Set, ast.Tuple)):
            export_kind = "object-literal"

        self.metadata["exports"].append({
            "kind": export_kind,
            "name": target.id,
            "isDefault": False,
            "line": line,
            "column": col
        })

    def visit_Assign(self, node):
        line, col = self.get_line_col(node)
        if not self.block_stack and not self.class_stack:
            for target in node.targets:
                self._record_module_level_assignment_export(target, node.value, line, col)
        self.generic_visit(node)

    def visit_AnnAssign(self, node):
        line, col = self.get_line_col(node)
        if not self.block_stack and not self.class_stack:
            self._record_module_level_assignment_export(node.target, node.value, line, col)
        self.generic_visit(node)


def parse_python_ast(file_path):
    with open(file_path, 'r', encoding='utf-8') as f:
        source = f.read()
    
    tree = ast.parse(source)
    visitor = CorrdexVisitor()
    visitor.visit(tree)
    
    return visitor.metadata

def process_file(fp):
    if not os.path.exists(fp):
        return fp, {"error": "File not found"}
    try:
        metadata = parse_python_ast(fp)
        return fp, metadata
    except Exception as e:
        return fp, {"error": str(e)}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No file path provided"}))
        sys.exit(1)
        
    if sys.argv[1] == "--batch":
        if len(sys.argv) < 4:
            print(json.dumps({"error": "No batch or output file provided"}))
            sys.exit(1)
        
        batch_file = sys.argv[2]
        out_file = sys.argv[3]
        if not os.path.exists(batch_file):
            print(json.dumps({"error": "Batch file not found"}))
            sys.exit(1)
            
        with open(batch_file, 'r', encoding='utf-8') as f:
            file_paths = json.load(f)
            
        results = {}
        import concurrent.futures
        import multiprocessing
        
        workers = min(multiprocessing.cpu_count(), len(file_paths) or 1)
        
        with concurrent.futures.ProcessPoolExecutor(max_workers=workers) as executor:
            for fp, metadata in executor.map(process_file, file_paths):
                results[fp] = metadata
        
        with open(out_file, 'w', encoding='utf-8') as f:
            json.dump(results, f)
    else:
        file_path = sys.argv[1]
        if not os.path.exists(file_path):
            print(json.dumps({"error": "File not found"}))
            sys.exit(1)
            
        try:
            metadata = parse_python_ast(file_path)
            print(json.dumps(metadata))
        except Exception as e:
            print(json.dumps({"error": str(e)}))
            sys.exit(1)

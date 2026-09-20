import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";
import {
  Conversation,
  ConversationContent,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
  Task,
  TaskContent,
  TaskItem,
  TaskItemFile,
  TaskTrigger,
} from "@/components/ai-elements/task";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";

const TRECHO = `public decimal CalcularPremio(Pedido pedido)
{
    var taxa = _tabela.Buscar(pedido.Cobertura);
    return pedido.ValorDoPedido * taxa;
}`;

/**
 * Vitrine dos componentes que as telas do M4a vao usar.
 *
 * Ela existe para provar que o vendor do shadcn e do AI Elements entrou de
 * verdade: bloco de codigo com destaque, raciocinio, ferramenta, tarefa e
 * conversa montando na janela. As telas de verdade entram nas proximas
 * stories e tomam o lugar daqui.
 */
export function App() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <Conversation className="h-screen">
        <ConversationContent className="mx-auto max-w-3xl gap-6">
          <h1 className="font-semibold text-2xl">Locum</h1>

          <Message from="assistant">
            <MessageContent>
              <MessageResponse>
                A janela subiu com os componentes vendorizados. As telas entram
                nas proximas stories.
              </MessageResponse>
            </MessageContent>
          </Message>

          <Reasoning defaultOpen={false} duration={12}>
            <ReasoningTrigger />
            <ReasoningContent>
              O passo de auditoria leu o diff antes de abrir achado.
            </ReasoningContent>
          </Reasoning>

          <Task defaultOpen>
            <TaskTrigger title="Arquivos lidos no passo de triagem" />
            <TaskContent>
              <TaskItem>
                Leu <TaskItemFile>CalculadoraDePremio.cs</TaskItemFile>
              </TaskItem>
            </TaskContent>
          </Task>

          <Tool defaultOpen={false}>
            <ToolHeader state="output-available" type="tool-list_findings" />
            <ToolContent>
              <ToolInput input={{ runId: "run-exemplo" }} />
              <ToolOutput errorText={undefined} output={{ achados: 4 }} />
            </ToolContent>
          </Tool>

          <div data-locum-probe="code-block">
            <CodeBlock code={TRECHO} language="csharp" showLineNumbers>
              <CodeBlockCopyButton />
            </CodeBlock>
          </div>

          {/*
            Marcador do smoke. Ele confere que este elemento esta com display
            none, o que so acontece se a folha construida pelo Tailwind chegou
            na pagina: raiz montada prova o React, nao prova o CSS.
          */}
          <span data-locum-probe="tailwind" className="hidden">
            folha de estilo carregada
          </span>
        </ConversationContent>
      </Conversation>
    </main>
  );
}

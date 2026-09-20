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
 * Espaco reservado das execucoes, com os componentes que a story M4a.5 vai
 * usar de verdade montados em cima de dados de exemplo.
 *
 * Eles ficam aqui, e nao numa pagina de vitrine a parte, porque esta e a tela
 * que vai consumi-los: raciocinio, chamada de ferramenta, tarefa e bloco de
 * codigo sao a linha do tempo de um passo. O smoke confere o destaque do
 * shiki por este caminho, entao o que ele prova e o caminho que fica.
 */
export function Execucoes() {
  return (
    <Conversation className="h-full">
      <ConversationContent className="gap-6 px-0">
        <p className="text-muted-foreground text-sm">
          A lista de execucoes e a linha do tempo dos passos entram na proxima
          leva. O que aparece abaixo sao os componentes que elas vao usar.
        </p>

        <Message from="assistant">
          <MessageContent>
            <MessageResponse>
              A janela subiu com os componentes vendorizados.
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
      </ConversationContent>
    </Conversation>
  );
}

/*
 * Os componentes do AI Elements pedem `cn` daqui, e os do shadcn pedem do
 * pacote `cn`. Reexportar mantem uma implementacao so: duas versoes de merge
 * de classe brigariam entre si no mesmo elemento.
 */
export { cn } from "cn";

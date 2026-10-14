import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { cn } from "./lib/utils";

export { SURFACE_LEVELS, type SurfaceLevel } from "./theme/surface";

export {
  POPOVER_WIDTH,
  POPOVER_PADDING,
  POPOVER_MAX_HEIGHT,
  type PopoverWidth,
  type PopoverPadding,
  type PopoverMaxHeight,
} from "./theme/popover-width";

export {
  ControlSizeProvider,
  useControlSize,
  iconSizeFor,
  textSizeFor,
  textStepFor,
  buttonTextClassFor,
  type ControlSize,
  type ButtonIconSize,
  type DensityControlled,
} from "./theme/control-size";

export { SingleLineProvider, useSingleLine } from "./theme/single-line";
export {
  SidewaysScrollProvider,
  useSidewaysScroll,
} from "./theme/sideways-scroll";
export { MenuSurfaceProvider, useMenuSurface } from "./theme/menu-surface";

export {
  MENU_ROW,
  MENU_ROW_PAINT,
  MENU_ROW_CHECKED,
  MENU_LABEL,
  MENU_LABEL_PAINT,
  MENU_VALUE,
  MENU_SEPARATOR,
} from "./theme/menu-row";

export { Button, buttonVariants } from "./components/ui/button";
export { ButtonGroup } from "./components/ui/button-group";
export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./components/ui/dialog";
export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSection,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "./components/ui/dropdown-menu";
export type { MenuRowAction } from "./components/ui/dropdown-menu";
export { Input } from "./components/ui/input";
export { Textarea } from "./components/ui/textarea";
export {
  PortalThemeScopeProvider,
  usePortalThemeScope,
  appThemeScope,
  subThemeScope,
  fixedThemeScope,
  isAppThemeScope,
  isSubThemeScope,
  themeScopeSelectors,
} from "./components/portal-theme-scope";
export {
  PortalForwardProvider,
  usePortalForwardedAttrs,
  useRegionForwardedAttrs,
  type PortalForwardedAttrs,
} from "./components/portal-forward";
export {
  OverlayPanel,
  type OverlayPanelProps,
} from "./components/overlay-panel";
export {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "./components/ui/popover";
export {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "./components/ui/resizable";
export { ScrollArea, ScrollBar } from "./components/ui/scroll-area";
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
export { Separator } from "./components/ui/separator";
export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
} from "./components/ui/sheet";
export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
  type SidebarToggleGlyph,
  type SidebarToggleIcons,
} from "./components/ui/sidebar";
export {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "./components/ui/tooltip";

export default {
  description:
    "Global UI kit: the cn() class-merge util, the 14 shadcn/ui primitives, the theme/app.css global stylesheet, and the ControlSize affordance-sizing context.",
  contributions: [],
} satisfies PluginDefinition;

import { LockIcon } from "lucide-react";
import { Select, SelectItem, SelectPopup, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControlIcon, ComposerSelectControl } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";
import type { RuntimePolicyChoice } from "./runtimePolicySelection";

export function RuntimePolicySelect(props: {
  value: string;
  choices: ReadonlyArray<RuntimePolicyChoice>;
  disabled?: boolean | undefined;
  hidden?: boolean | undefined;
  size?: "sm" | "xs" | undefined;
  onOpen?: (() => void) | undefined;
  onValueChange: (value: string) => void;
}) {
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const floatingLayerProps = useComposerMenuProps();
  const selected = props.choices.find((choice) => choice.value === props.value);
  const size = props.size ?? "sm";
  return (
    <Tooltip>
      <Select
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (nextOpen) props.onOpen?.();
        }}
        value={props.value}
        disabled={props.disabled}
        onValueChange={(value) => {
          if (
            !value ||
            props.disabled ||
            !props.choices.some((choice) => choice.value === value && !choice.disabled)
          )
            return;
          props.onValueChange(value);
        }}
      >
        <TooltipTrigger
          render={
            <ComposerSelectControl
              data-composer-shortcut="composer.mode"
              size={size}
              aria-label="Runtime mode"
            />
          }
        >
          <ComposerControlIcon icon={selected?.icon ?? LockIcon} size={size} />
          <SelectValue data-composer-control-label>
            {selected?.label ?? "Unavailable policy"}
          </SelectValue>
        </TooltipTrigger>
        <SelectPopup alignItemWithTrigger={false} {...floatingLayerProps}>
          {props.choices.map((choice) => {
            const ChoiceIcon = choice.icon;
            return (
              <SelectItem
                key={choice.value}
                value={choice.value}
                disabled={choice.disabled}
                hideIndicator
                className="min-w-64"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                      <ChoiceIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      {choice.label}
                    </span>
                    <span className="text-muted-foreground text-xs leading-4">
                      {choice.description}
                    </span>
                  </div>
                </div>
              </SelectItem>
            );
          })}
        </SelectPopup>
      </Select>
      <TooltipPopup side="top">
        {selected?.description ?? "Select an access policy before sending."}
      </TooltipPopup>
    </Tooltip>
  );
}

import React from 'react';
import { Droplet, Flame } from 'lucide-react';
import { ServiceType } from '../types/domain';

interface ServiceToggleBarProps {
  activeService: ServiceType;
  onSelectService: (service: ServiceType) => void;
  waterBadge?: string;
  gasBadge?: string;
}

export const ServiceToggleBar: React.FC<ServiceToggleBarProps> = ({
  activeService,
  onSelectService,
  waterBadge,
  gasBadge,
}) => {
  const isWater = activeService === 'water';
  const isGas = activeService === 'gas';

  return (
    <div
      className="grid grid-cols-2 rounded-xl overflow-hidden border-2 border-[#0D8A9E] bg-white shadow-xs"
      role="tablist"
      aria-label="Seleção de serviço Água ou Gás"
    >
      <button
        type="button"
        role="tab"
        aria-selected={isWater}
        onClick={() => onSelectService('water')}
        className={`min-h-[48px] px-4 py-2.5 flex items-center justify-center gap-2 font-bold text-base transition-colors whitespace-nowrap ${
          isWater
            ? 'bg-[#0D8A9E] text-white'
            : 'bg-white text-[#0D8A9E] hover:bg-cyan-50/60'
        }`}
      >
        <Droplet
          className={`w-5 h-5 shrink-0 ${
            isWater ? 'fill-white text-white' : 'fill-[#0D8A9E] text-[#0D8A9E]'
          }`}
        />
        <span>Água</span>
        {waterBadge && (
          <span
            className={`text-xs font-mono tabular-nums px-1.5 py-0.5 rounded ${
              isWater
                ? 'bg-black/20 text-white'
                : 'bg-slate-100 text-slate-700'
            }`}
          >
            {waterBadge}
          </span>
        )}
      </button>

      <button
        type="button"
        role="tab"
        aria-selected={isGas}
        onClick={() => onSelectService('gas')}
        className={`min-h-[48px] px-4 py-2.5 flex items-center justify-center gap-2 font-bold text-base transition-colors whitespace-nowrap ${
          isGas
            ? 'bg-[#E08E00] text-white'
            : 'bg-white text-[#B45309] hover:bg-amber-50/60'
        }`}
      >
        <Flame
          className={`w-5 h-5 shrink-0 ${
            isGas ? 'fill-white text-white' : 'fill-[#E08E00] text-[#E08E00]'
          }`}
        />
        <span>Gás</span>
        {gasBadge && (
          <span
            className={`text-xs font-mono tabular-nums px-1.5 py-0.5 rounded ${
              isGas ? 'bg-black/20 text-white' : 'bg-slate-100 text-slate-700'
            }`}
          >
            {gasBadge}
          </span>
        )}
      </button>
    </div>
  );
};

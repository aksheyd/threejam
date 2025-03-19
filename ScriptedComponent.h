#ifndef SCRIPTED_COMPONENT
#define SCRIPTED_COMPONENT

#include <iostream>
#include <string>
#include "Component.h"

class ScriptedComponent : public Component {
public:
	ScriptedComponent(const std::string& _name) : Component(_name) {}
};

#endif
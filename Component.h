#ifndef COMPONENT_H
#define COMPONENT_H

#include <iostream>
#include <string>
#include "Object.h"

class Component : public Object
{
public:
	//GameObject gameObject;
	//Transform transform;

	Component(const std::string& _name) : Object(_name) { }
	//~Component();

	// these are behaviours -> monobehaviours
	virtual void Start() {

	}

	virtual void Update() {

	}

	virtual void Destroy() {

	}
};

#endif
